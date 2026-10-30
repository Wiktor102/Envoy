import { createHash, randomUUID } from "node:crypto";
import type {
	AgentDecision,
	ConnectorSyncResult,
	ConversationSnapshot,
	PendingReply,
	SendReplyCommand,
	SendResult,
	TaskControlAction,
	TaskState,
} from "@envoy/contracts";
import { DEFAULT_REPLY_DELAY_SECONDS } from "@envoy/contracts";
import type { Agent } from "../agent/agent.js";
import type { BrowserConnector } from "../connectors/browser-connector.js";
import { ExtensionConnector } from "../connectors/extension-connector.js";

const LEASE_MS = 8_000;
const SEND_RESULT_TIMEOUT_MS = 30_000;
const TERMINAL_RETENTION_MS = 60 * 60 * 1000;
const MAX_REPLY_LENGTH = 4000;

type Attempt = {
	command: SendReplyCommand;
	taskId: string;
	connectorId: string;
	context: string;
	authorized: boolean;
	retired: boolean;
	// Even an unauthorized command may have inserted a draft that the user sent.
	// Wait for its result before allowing any replacement send or task.
	awaitingRetiredResult: boolean;
	// Send now arrived after this attempt was claimed but before it was
	// authorized. A rejection then retries once instead of waiting for the user.
	sendNowRequested: boolean;
	deadline: number;
};
type Options = {
	now?: () => number;
	replyDelayMs?: number;
	leaseMs?: number;
	connector?: () => BrowserConnector;
};

// The state is intentionally in backend memory. A backend restart cannot
// revive a pending send. Only one connector can own a live task.
export class TaskService {
	private task: TaskState | null = null;
	private owner: string | null = null;
	private developerMode = false;
	private connector: BrowserConnector;
	private leaseUntil = 0;
	private leaseTimer: ReturnType<typeof setTimeout> | undefined;
	private attemptTimer: ReturnType<typeof setTimeout> | undefined;
	private retentionTimer: ReturnType<typeof setTimeout> | undefined;
	private epoch = 0;
	private generation: AbortController | null = null;
	private inFlight: Attempt | null = null;
	private readonly attempts = new Map<string, Attempt>();
	private readonly processedRevisions = new Set<string>();
	private readonly suppressedRevisions = new Set<string>();
	private readonly suppressedContexts = new Set<string>();
	private requiresVerification = false;
	// Set only when an unreadable view paused an agent that was not waiting for
	// the user or an edit. Any other pause, control, or reconnection clears it.
	private resumeWhenReadable = false;
	private readonly now: () => number;
	private readonly replyDelayMs: number;
	private readonly leaseMs: number;
	private readonly newConnector: () => BrowserConnector;

	constructor(
		private readonly agent: Agent,
		options: Options = {},
	) {
		this.now = options.now ?? Date.now;
		this.replyDelayMs = options.replyDelayMs ?? DEFAULT_REPLY_DELAY_SECONDS * 1000;
		this.leaseMs = options.leaseMs ?? LEASE_MS;
		this.newConnector = options.connector ?? (() => new ExtensionConnector());
		this.connector = this.newConnector();
	}

	start(connectorId: string, goal: string, snapshot: ConversationSnapshot, developerMode = false): TaskState {
		this.expireLease();
		if (this.task && this.task.status !== "completed" && this.task.status !== "taken_over") {
			throw new Error("A task is already active. Take over the existing task first.");
		}
		if (this.hasAwaitingRetiredResult()) {
			throw new Error("A previous send is still being checked. Try again shortly.");
		}
		if (this.task && this.requiresVerification) {
			throw new Error("The previous send may have completed. Check the conversation and delete the old task first.");
		}
		const sameChat = this.task?.chatId === snapshot.chatId;
		this.invalidate();
		if (this.retentionTimer) clearTimeout(this.retentionTimer);
		this.retentionTimer = undefined;
		this.connector = this.newConnector();
		this.connector.updateConversation(structuredClone(snapshot));
		this.processedRevisions.clear();
		if (!sameChat) {
			this.suppressedRevisions.clear();
			this.suppressedContexts.clear();
			this.requiresVerification = false;
		}
		this.attempts.clear();
		this.inFlight = null;
		this.resumeWhenReadable = false;
		this.owner = connectorId;
		this.developerMode = developerMode;
		this.task = {
			id: randomUUID(),
			chatId: snapshot.chatId,
			goal: goal.trim(),
			status: this.requiresVerification ? "needs_user" : "waiting",
			pendingReply: null,
			detail: this.requiresVerification
				? "The previous send may have completed. Check the conversation before resuming."
				: null,
		};
		this.touch();
		this.maybeGenerate();
		return this.state()!;
	}

	attach(connectorId: string, taskId: string, snapshot: ConversationSnapshot): TaskState {
		this.expireLease();
		if (!this.task || this.task.id !== taskId || snapshot.chatId !== this.task.chatId) {
			throw new Error("Task or conversation not found.");
		}
		if (this.leaseActive() || this.inFlight || this.task.status !== "paused") {
			throw new Error("The agent tab is still connected or the task is not paused.");
		}
		this.resumeWhenReadable = false;
		this.owner = connectorId;
		this.connector.updateConversation(structuredClone(snapshot));
		this.touch();
		// Preserve a warning about an uncertain send until the user has seen it.
		this.task.detail = this.requiresVerification
			? "Reconnected. A send may have completed; check the conversation before resuming."
			: "Reconnected. Resume when you are ready.";
		return this.state()!;
	}

	clear(connectorId: string, taskId: string): void {
		this.expireLease();
		const task = this.task;
		if (!task || task.id !== taskId || (this.owner !== connectorId && this.leaseActive())) {
			throw new Error("Task not found.");
		}
		if (task.status !== "completed" && task.status !== "taken_over") {
			throw new Error("Take over the task before deleting it.");
		}
		if (this.hasAwaitingRetiredResult()) {
			throw new Error("A previous send is still being checked. Try again shortly.");
		}
		this.erase();
	}

	control(connectorId: string, taskId: string, action: TaskControlAction, text?: string): TaskState {
		this.expireLease();
		const task = this.requireOwner(connectorId, taskId);
		this.resumeWhenReadable = false;
		switch (action) {
			case "edit": {
				if (task.status === "sending" && this.inFlight) {
					if (this.inFlight.authorized) {
						this.invalidate(true);
						task.status = "needs_user";
						task.detail = "The send may have completed. Check the conversation before editing.";
						break;
					}
					const command = this.inFlight.command;
					this.invalidate(true);
					task.pendingReply = { ...command, commandId: randomUUID(), sendAt: null };
					task.status = "pending";
				}
				if (task.status !== "pending" || !task.pendingReply) throw new Error("There is no reply to edit.");
				task.pendingReply.sendAt = null;
				task.status = "editing";
				task.detail = "The countdown is stopped while you edit.";
				break;
			}
			case "save-edit": {
				if (task.status !== "editing" || !task.pendingReply) throw new Error("There is no reply being edited.");
				const updated = checkedReply(text);
				task.pendingReply.text = updated;
				task.pendingReply.sendAt = null;
				task.status = "pending";
				task.detail = "Edited reply saved. Choose Send now when it is ready.";
				break;
			}
			case "send-now": {
				// The countdown can hand the reply to the tab while this request is
				// in flight. The tab may reject that claim, so keep the request.
				if (task.status === "sending" && this.inFlight) {
					if (!this.inFlight.authorized) this.inFlight.sendNowRequested = true;
					break;
				}
				if (task.status !== "pending" || !task.pendingReply) throw new Error("There is no reply ready to send.");
				if (!this.leaseActive()) throw new Error("The agent tab is disconnected.");
				task.pendingReply.sendAt = this.now();
				task.detail = "Sending when the agent tab checks in.";
				break;
			}
			case "cancel": {
				if (!["thinking", "pending", "editing", "sending"].includes(task.status)) {
					throw new Error("There is no reply to cancel.");
				}
				const snapshot = this.connector.readConversation();
				if (snapshot) {
					this.suppressedRevisions.add(snapshot.revision);
					this.suppressedContexts.add(textContext(snapshot));
				}
				const uncertain = this.invalidate(true);
				task.pendingReply = null;
				task.status = uncertain ? "needs_user" : "waiting";
				task.detail = uncertain
					? "The send may have completed. Check the conversation before resuming."
					: "Reply cancelled. Waiting for a new message.";
				break;
			}
			case "pause": {
				if (task.status === "completed" || task.status === "taken_over") throw new Error("This task has ended.");
				const discarded = task.pendingReply;
				const unstarted = this.inFlight && !this.inFlight.authorized ? this.inFlight.command : null;
				const uncertain = this.invalidate(true);
				if (discarded && !uncertain) this.processedRevisions.delete(discarded.expectedRevision);
				if (unstarted && !uncertain) this.processedRevisions.delete(unstarted.expectedRevision);
				task.pendingReply = null;
				task.status = "paused";
				task.detail =
					uncertain || this.requiresVerification
						? "Paused. The send may have completed; check the conversation before resuming."
						: this.hasAwaitingRetiredResult()
							? "Paused. Checking whether the previous send completed."
							: "Paused by you.";
				break;
			}
			case "resume": {
				if (task.status !== "paused" && task.status !== "needs_user") throw new Error("The task is not paused.");
				const snapshot = this.connector.readConversation();
				if (!this.leaseActive() || !snapshot || snapshot.chatId !== task.chatId) {
					throw new Error("Reconnect the agent tab to the original conversation first.");
				}
				this.invalidate();
				this.requiresVerification = false;
				task.pendingReply = null;
				task.status = "waiting";
				task.detail = null;
				this.maybeGenerate();
				break;
			}
			case "take-over": {
				const uncertain = this.invalidate(true);
				task.pendingReply = null;
				task.status = "taken_over";
				task.detail =
					uncertain || this.requiresVerification
						? "You are in control. A send may have completed; check the conversation."
						: this.hasAwaitingRetiredResult()
							? "You are in control. Checking whether the previous send completed."
							: "You are in control of this conversation.";
				this.scheduleRetention(task.id);
				break;
			}
			case "update-goal": {
				if (task.status === "completed" || task.status === "taken_over") throw new Error("This task has ended.");
				const goal = checkedText(text);
				const uncertain = this.invalidate(true);
				task.goal = goal;
				task.pendingReply = null;
				if (uncertain || this.requiresVerification) {
					task.status = "needs_user";
					task.detail = "The send may have completed. Check the conversation before resuming.";
				} else {
					this.processedRevisions.clear();
					if (task.status !== "paused") {
						task.status = "waiting";
						task.detail = null;
						this.maybeGenerate();
					}
				}
				break;
			}
		}
		return this.state()!;
	}

	sync(connectorId: string, snapshot: ConversationSnapshot | null, developerMode?: boolean): ConnectorSyncResult {
		this.expireLease();
		if (!this.task) return { task: null, isOwner: false, command: null };
		if (connectorId !== this.owner) {
			return { task: { ...this.state()!, goal: "", pendingReply: null, detail: null }, isOwner: false, command: null };
		}
		const task = this.task;
		// Ended tasks can still be viewed and deleted, but no longer accept
		// conversation updates, including requests sent before the task ended.
		if (task.status === "completed" || task.status === "taken_over") {
			return { task: this.state(), isOwner: true, command: null };
		}
		const previous = this.connector.readConversation();
		if (!snapshot || snapshot.chatId !== task.chatId) {
			// A photo that is still loading or a brief scroll can make the view
			// unreadable across several syncs. Preserve only this automatic pause.
			const resumable =
				!snapshot &&
				(["waiting", "thinking"].includes(task.status) ||
					(task.status === "pending" && task.pendingReply?.sendAt != null) ||
					(task.status === "paused" && this.resumeWhenReadable)) &&
				!this.inFlight &&
				!this.requiresVerification;
			// Failed reads still prove the owner is connected. A missing heartbeat
			// must expire this recovery permission just like any other connection.
			if (resumable) this.touch();
			else this.leaseUntil = 0;
			this.pauseForDisconnect(
				snapshot
					? "The agent tab changed conversations."
					: resumable
						? "The conversation is unavailable. Envoy resumes when it can read the latest messages."
						: "The conversation is unavailable.",
			);
			this.resumeWhenReadable = resumable;
			this.connector.updateConversation(null);
			return { task: this.state(), isOwner: true, command: null };
		}
		this.touch();
		if (developerMode !== undefined) this.developerMode = developerMode;
		const copy = structuredClone(snapshot);
		if (previous && previous.revision === copy.revision && semanticMessages(previous) !== semanticMessages(copy)) {
			this.pauseForDisconnect("The conversation could not be verified. Reopen it and resume.");
			this.connector.updateConversation(null);
			this.leaseUntil = 0;
			return { task: this.state(), isOwner: true, command: null };
		}
		if (previous && previous.revision !== copy.revision) {
			// After authorization, a new revision can be the outgoing bubble
			// itself. Keep the attempt until its explicit report arrives.
			if (!(task.status === "sending" && this.inFlight?.authorized)) {
				const uncertain = this.invalidate();
				task.pendingReply = null;
				if (uncertain) {
					task.status = "needs_user";
					task.detail = "The send may have completed. Check the conversation before resuming.";
				} else if (!["paused", "needs_user", "completed", "taken_over"].includes(task.status)) {
					task.status = "waiting";
					task.detail = null;
				}
			}
		}
		this.connector.updateConversation(copy);
		if (this.resumeWhenReadable) {
			this.resumeWhenReadable = false;
			if (task.status === "paused" && !this.requiresVerification && !this.inFlight) {
				task.status = "waiting";
				task.detail = null;
			}
		}
		if (task.status === "waiting") this.maybeGenerate();
		let command: SendReplyCommand | null = null;
		if (task.status === "pending" && task.pendingReply?.sendAt !== null && task.pendingReply?.sendAt !== undefined) {
			if (task.pendingReply.sendAt <= this.now()) {
				if (this.hasAwaitingRetiredResult()) {
					task.detail = "Checking whether the previous send completed before sending this reply.";
					return { task: this.state(), isOwner: true, command: null };
				}
				const { commandId, chatId, expectedRevision, text } = task.pendingReply;
				command = this.connector.claimSend({ commandId, chatId, expectedRevision, text });
				if (command) {
					const attempt = {
						command,
						taskId: task.id,
						connectorId,
						context: textContext(copy),
						authorized: false,
						retired: false,
						awaitingRetiredResult: false,
						sendNowRequested: false,
						deadline: this.now() + SEND_RESULT_TIMEOUT_MS,
					};
					this.inFlight = attempt;
					this.attempts.set(commandId, attempt);
					this.scheduleAttemptTimeout();
					task.pendingReply = null;
					task.status = "sending";
					task.detail = "Checking the conversation before sending.";
				} else {
					this.pauseForDisconnect("The reply could not be verified. Check the conversation before resuming.");
				}
			}
		}
		return { task: this.state(), isOwner: true, command };
	}

	authorize(connectorId: string, commandId: string, chatId: string, revision: string): boolean {
		this.expireLease();
		const task = this.task;
		const attempt = this.inFlight;
		const snapshot = this.connector.readConversation();
		if (
			!task ||
			connectorId !== this.owner ||
			!this.leaseActive() ||
			task.status !== "sending" ||
			!attempt ||
			attempt.retired ||
			attempt.authorized ||
			attempt.command.commandId !== commandId ||
			attempt.command.chatId !== chatId ||
			attempt.command.expectedRevision !== revision ||
			task.chatId !== chatId ||
			snapshot?.chatId !== chatId ||
			snapshot.revision !== revision
		)
			return false;
		attempt.authorized = true;
		return true;
	}

	report(connectorId: string, commandId: string, result: SendResult): TaskState | null {
		this.expireLease();
		if (!this.task) return null;
		const attempt = this.attempts.get(commandId);
		if (!attempt || attempt.taskId !== this.task.id || attempt.connectorId !== connectorId) {
			return connectorId === this.owner ? this.state() : null;
		}
		const returnState = () => (connectorId === this.owner ? this.state() : null);
		// Repeated reports are ignored. A rejected attempt can never be retried
		// with the same command ID, and an uncertain result always needs review.
		this.attempts.delete(commandId);
		if (this.inFlight === attempt) {
			this.inFlight = null;
		}
		if (attempt.awaitingRetiredResult) {
			attempt.awaitingRetiredResult = false;
			if (result === "rejected") {
				// A pre-authorization rejection proves that this attempt did not
				// dispatch. Cancel already records suppression; edit and pause must
				// remain usable for the same conversation.
				if (this.task.status === "waiting") this.maybeGenerate();
				if (this.task.status === "completed" || this.task.status === "taken_over") {
					this.task.detail = "You are in control of this conversation.";
					this.scheduleRetention(this.task.id);
				}
			} else {
				// An unauthorized connector cannot prove it sent the reply. The
				// draft could still have been sent manually, so require review.
				this.markRetiredAttemptUncertain(attempt);
			}
			this.scheduleAttemptTimeout();
			return returnState();
		}
		this.scheduleAttemptTimeout();
		if (attempt.retired) return returnState();
		this.processedRevisions.add(attempt.command.expectedRevision);
		const current = this.connector.readConversation();
		if (
			result === "rejected" &&
			this.task.status === "sending" &&
			current?.chatId === attempt.command.chatId &&
			current.revision === attempt.command.expectedRevision
		) {
			// A rejection proves the reply was not dispatched. Return it to the
			// user under a new command ID; only an explicit Send now retries it.
			this.task.pendingReply = {
				...attempt.command,
				commandId: randomUUID(),
				sendAt: attempt.sendNowRequested ? this.now() : null,
			};
			this.task.status = "pending";
			this.task.detail = attempt.sendNowRequested
				? "Sending when the agent tab checks in."
				: "The reply was not sent. Choose Send now to try again, or cancel it.";
			return returnState();
		}
		this.suppressedRevisions.add(attempt.command.expectedRevision);
		this.suppressedContexts.add(attempt.context);
		if (this.task.status !== "sending") return returnState();
		if (result === "sent" && attempt.authorized) {
			this.task.status = "waiting";
			this.task.detail = "Reply sent. Waiting for a new message.";
		} else {
			if (result !== "rejected") this.requiresVerification = true;
			this.task.status = "needs_user";
			this.task.detail =
				result === "rejected"
					? "The reply was not sent. Check the conversation before resuming."
					: "The send could not be confirmed. Check the conversation before resuming.";
		}
		return returnState();
	}

	disconnect(connectorId: string): void {
		this.expireLease();
		if (!this.task || connectorId !== this.owner) return;
		this.leaseUntil = 0;
		this.pauseForDisconnect("The agent tab disconnected.");
		this.connector.updateConversation(null);
	}

	private state(): TaskState | null {
		return this.task ? structuredClone(this.task) : null;
	}

	private erase(): void {
		this.invalidate();
		if (this.leaseTimer) clearTimeout(this.leaseTimer);
		if (this.attemptTimer) clearTimeout(this.attemptTimer);
		if (this.retentionTimer) clearTimeout(this.retentionTimer);
		this.leaseTimer = undefined;
		this.attemptTimer = undefined;
		this.retentionTimer = undefined;
		this.task = null;
		this.owner = null;
		this.leaseUntil = 0;
		this.connector = this.newConnector();
		this.inFlight = null;
		this.attempts.clear();
		this.processedRevisions.clear();
		this.suppressedRevisions.clear();
		this.suppressedContexts.clear();
		this.requiresVerification = false;
		this.resumeWhenReadable = false;
	}

	private scheduleRetention(taskId: string): void {
		if (this.retentionTimer) clearTimeout(this.retentionTimer);
		if (this.requiresVerification || this.hasAwaitingRetiredResult()) {
			this.retentionTimer = undefined;
			return;
		}
		this.retentionTimer = setTimeout(() => {
			if (
				!this.requiresVerification &&
				!this.hasAwaitingRetiredResult() &&
				this.task?.id === taskId &&
				(this.task.status === "completed" || this.task.status === "taken_over")
			)
				this.erase();
		}, TERMINAL_RETENTION_MS);
		this.retentionTimer.unref();
	}

	private requireOwner(connectorId: string, taskId: string): TaskState {
		if (!this.task || this.task.id !== taskId || this.owner !== connectorId) throw new Error("Task not found.");
		return this.task;
	}

	private touch(): void {
		this.leaseUntil = this.now() + this.leaseMs;
		if (this.leaseTimer) clearTimeout(this.leaseTimer);
		this.leaseTimer = setTimeout(() => this.expireLease(), this.leaseMs);
		this.leaseTimer.unref();
	}

	private leaseActive(): boolean {
		return this.leaseUntil > this.now();
	}

	private expireLease(): void {
		if (this.task && this.leaseUntil && !this.leaseActive()) {
			this.leaseUntil = 0;
			this.pauseForDisconnect("The agent tab stopped checking in.");
			this.connector.updateConversation(null);
		}
		this.expireAttempt();
	}

	private hasAwaitingRetiredResult(): boolean {
		for (const attempt of this.attempts.values()) {
			if (attempt.awaitingRetiredResult) return true;
		}
		return false;
	}

	private scheduleAttemptTimeout(): void {
		if (this.attemptTimer) clearTimeout(this.attemptTimer);
		this.attemptTimer = undefined;
		const deadlines = [...this.attempts.values()]
			.filter((attempt) => this.inFlight === attempt || attempt.awaitingRetiredResult)
			.map((attempt) => attempt.deadline);
		if (!deadlines.length) return;
		const delay = Math.max(0, Math.min(...deadlines) - this.now());
		this.attemptTimer = setTimeout(() => {
			this.attemptTimer = undefined;
			this.expireAttempt();
		}, delay);
		this.attemptTimer.unref();
	}

	private expireAttempt(): void {
		if (this.inFlight && this.inFlight.deadline <= this.now()) {
			this.invalidate();
			if (this.task?.status === "sending") {
				this.task.status = "needs_user";
				this.task.detail = "The send could not be confirmed. Check the conversation before resuming.";
			}
		}
		for (const attempt of this.attempts.values()) {
			if (!attempt.awaitingRetiredResult || attempt.deadline > this.now()) continue;
			attempt.awaitingRetiredResult = false;
			this.attempts.delete(attempt.command.commandId);
			this.markRetiredAttemptUncertain(attempt);
		}
		this.scheduleAttemptTimeout();
	}

	private markRetiredAttemptUncertain(attempt: Attempt): void {
		if (!this.task || this.task.id !== attempt.taskId) return;
		this.invalidate();
		this.requiresVerification = true;
		this.suppressedRevisions.add(attempt.command.expectedRevision);
		this.suppressedContexts.add(attempt.context);
		this.task.pendingReply = null;
		if (this.task.status === "taken_over" || this.task.status === "completed") {
			if (this.retentionTimer) clearTimeout(this.retentionTimer);
			this.retentionTimer = undefined;
			this.task.detail = "A previous send may have completed. Check the conversation before starting another task.";
		} else if (this.task.status === "paused") {
			this.task.detail = "Paused. A previous send may have completed; check the conversation before resuming.";
		} else {
			this.task.status = "needs_user";
			this.task.detail = "A previous send may have completed. Check the conversation before resuming.";
		}
	}

	private pauseForDisconnect(message: string): void {
		this.resumeWhenReadable = false;
		if (!this.task || this.task.status === "completed" || this.task.status === "taken_over") return;
		const discarded = this.task.pendingReply;
		const uncertain = this.invalidate();
		if (discarded && !uncertain) this.processedRevisions.delete(discarded.expectedRevision);
		this.task.pendingReply = null;
		this.task.status = "paused";
		this.task.detail =
			uncertain || this.requiresVerification
				? `${message} A send may have completed; check the conversation.`
				: message;
	}

	// Abort in-progress work and retire any handed-out command. Even a command
	// without an acknowledgement can have reached the tab, so treat it as uncertain.
	private invalidate(explicitControl = false): boolean {
		this.epoch++;
		this.generation?.abort();
		this.generation = null;
		const uncertain = this.inFlight !== null && (!explicitControl || this.inFlight.authorized);
		if (this.inFlight) {
			this.inFlight.retired = true;
			this.processedRevisions.add(this.inFlight.command.expectedRevision);
			if (uncertain) {
				this.requiresVerification = true;
				this.suppressedRevisions.add(this.inFlight.command.expectedRevision);
				this.suppressedContexts.add(this.inFlight.context);
			} else if (explicitControl) {
				this.inFlight.awaitingRetiredResult = true;
			}
			this.inFlight = null;
		}
		this.scheduleAttemptTimeout();
		return uncertain;
	}

	private maybeGenerate(): void {
		const task = this.task;
		const snapshot = this.connector.readConversation();
		if (!task || task.status !== "waiting" || !snapshot || !this.leaseActive() || snapshot.chatId !== task.chatId)
			return;
		if (this.requiresVerification) {
			task.status = "needs_user";
			task.detail = "The send could not be confirmed. Check the conversation before resuming.";
			return;
		}
		if (this.hasAwaitingRetiredResult()) {
			task.detail = "Checking whether the previous send completed.";
			return;
		}
		if (
			this.processedRevisions.has(snapshot.revision) ||
			this.suppressedRevisions.has(snapshot.revision) ||
			this.suppressedContexts.has(textContext(snapshot))
		)
			return;
		// An unsent group event still withdraws the message before it.
		const latest = [...snapshot.messages].reverse().find((message) => message.direction !== "system" || message.unsent);
		if (latest?.unsent) {
			task.status = "needs_user";
			task.detail = "The latest message was unsent. Check the conversation before resuming.";
			return;
		}
		if (!latest || latest.direction === "outgoing") {
			task.detail = "Waiting for a new incoming message.";
			return;
		}
		if (latest.direction === "unknown") {
			task.status = "needs_user";
			task.detail = "The latest message has an unknown sender. Check the conversation before resuming.";
			return;
		}
		if (
			latest.attachments.length ||
			!latest.text.trim() ||
			(latest.replyTo &&
				(latest.replyTo.attachments.length || !latest.replyTo.text?.trim() || !latest.replyTo.context?.trim()))
		) {
			task.status = "needs_user";
			task.detail = "The latest message contains content Envoy cannot interpret.";
			return;
		}
		task.status = "thinking";
		task.detail = "Considering the conversation.";
		const epoch = ++this.epoch;
		const abort = new AbortController();
		this.generation = abort;
		const captured = structuredClone(snapshot);
		const taskCopy = this.state()!;
		void this.agent.run(taskCopy, captured, abort.signal).then(
			(decision) => this.acceptDecision(epoch, captured, decision),
			() => {
				if (this.epoch !== epoch || !this.task || this.task.status !== "thinking") return;
				this.generation = null;
				this.task.status = "needs_user";
				this.task.detail = process.env.MODEL_API_KEY?.trim()
					? "The model could not produce a decision. Check its configuration and resume."
					: "Set MODEL_API_KEY on the backend and resume.";
			},
		);
	}

	private acceptDecision(epoch: number, snapshot: ConversationSnapshot, decision: AgentDecision): void {
		const task = this.task;
		const current = this.connector.readConversation();
		if (
			this.epoch !== epoch ||
			!task ||
			task.status !== "thinking" ||
			!this.leaseActive() ||
			current?.chatId !== snapshot.chatId ||
			current.revision !== snapshot.revision
		)
			return;
		this.generation = null;
		this.processedRevisions.add(snapshot.revision);
		switch (decision.action) {
			case "reply": {
				let text: string;
				try {
					text = checkedReply(decision.text);
					if (this.developerMode) text = checkedReply(`> ${text}`);
				} catch {
					task.status = "needs_user";
					task.detail = "The model returned an invalid reply. Check the conversation.";
					return;
				}
				const pending: PendingReply = {
					commandId: randomUUID(),
					chatId: task.chatId,
					expectedRevision: snapshot.revision,
					text,
					sendAt: this.now() + this.replyDelayMs,
				};
				task.pendingReply = pending;
				task.status = "pending";
				task.detail = "Review the reply before it sends.";
				break;
			}
			case "wait":
				task.status = "waiting";
				task.detail = "Waiting for a new message.";
				break;
			case "ask":
				task.status = "needs_user";
				task.detail = decision.text;
				break;
			case "finish":
				task.status = "completed";
				task.detail = decision.text;
				this.scheduleRetention(task.id);
				break;
		}
	}
}

function checkedText(value: string | undefined): string {
	const text = value?.trim();
	if (!text || text.length > MAX_REPLY_LENGTH) throw new Error("Enter text between 1 and 4000 characters.");
	return text;
}

function checkedReply(value: string | undefined): string {
	if (value && /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) {
		throw new Error("Replies must be a single line without control characters.");
	}
	return checkedText(value);
}

function semanticMessages(snapshot: ConversationSnapshot): string {
	return JSON.stringify(snapshot.messages.map(({ id: _id, ...message }) => message));
}

// Reactions and other cosmetic DOM changes must not trigger another reply to
// the same text after a send or cancellation.
function textContext(snapshot: ConversationSnapshot): string {
	const contents = JSON.stringify(
		snapshot.messages.map(({ direction, text, replyTo, unsent }) => ({ direction, text, replyTo, unsent })),
	);
	return createHash("sha256").update(contents).digest("hex");
}
