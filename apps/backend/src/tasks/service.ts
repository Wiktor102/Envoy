import { createHash, randomUUID } from "node:crypto";
import type {
	AgentChatRole,
	AgentDecision,
	ConnectorSyncResult,
	ConversationMessage,
	ConversationSnapshot,
	PendingReply,
	ReplySettings,
	SendReplyCommand,
	SendResult,
	TaskControlAction,
	TaskState,
} from "@envoy/contracts";
import {
	DEFAULT_REPLY_DELAY_SECONDS,
	forwardableMediaSlots,
	hasControlCharacters,
	isTaskEnded,
	MAX_TASK_TEXT_LENGTH,
	messageContent,
} from "@envoy/contracts";
import type { Agent, EvaluationReason } from "../agent/agent.js";
import type { BrowserConnector } from "../connectors/browser-connector.js";
import { ExtensionConnector } from "../connectors/extension-connector.js";

const LEASE_MS = 8_000;
const SEND_RESULT_TIMEOUT_MS = 30_000;
const TERMINAL_RETENTION_MS = 60 * 60 * 1000;
const MAX_AGENT_CHAT = 50;
const AUTO_SEND_OFF = "Automatic sending is off. Choose Send now when it is ready.";

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
	// Delay used until a connector sends its reply settings.
	replyDelayMs?: number;
	random?: () => number;
	leaseMs?: number;
	connector?: () => BrowserConnector;
};

// The state is intentionally in backend memory. A backend restart cannot
// revive a pending send. Only one connector can own a live task.
export class TaskService {
	private task: TaskState | null = null;
	private owner: string | null = null;
	private developerMode = false;
	private replySettings: ReplySettings | null = null;
	// The pending reply whose countdown auto-send started. Send now also sets
	// sendAt, so only this reply stops when auto-send is switched off.
	private autoCountdown: string | null = null;
	private connector: BrowserConnector;
	private leaseUntil = 0;
	private leaseTimer: ReturnType<typeof setTimeout> | undefined;
	private attemptTimer: ReturnType<typeof setTimeout> | undefined;
	private retentionTimer: ReturnType<typeof setTimeout> | undefined;
	private epoch = 0;
	private generation: AbortController | null = null;
	// Retain the event through temporary unreadable views or retired-send checks.
	private evaluationReason: EvaluationReason = "new_message";
	// Last-seen plain texts by stable ID, for edit detection. Dies with the
	// task; cleared on delete/expire. Entries for scrolled-out messages are
	// kept; ambiguous duplicates are dropped fail-closed.
	private readonly lastSeenTexts = new Map<string, string>();
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
	private readonly random: () => number;
	private readonly leaseMs: number;
	private readonly newConnector: () => BrowserConnector;

	constructor(
		private readonly agent: Agent,
		options: Options = {},
	) {
		this.now = options.now ?? Date.now;
		this.replyDelayMs = options.replyDelayMs ?? DEFAULT_REPLY_DELAY_SECONDS * 1000;
		this.random = options.random ?? Math.random;
		this.leaseMs = options.leaseMs ?? LEASE_MS;
		this.newConnector = options.connector ?? (() => new ExtensionConnector());
		this.connector = this.newConnector();
	}

	start(
		connectorId: string,
		goal: string,
		snapshot: ConversationSnapshot,
		developerMode = false,
		replySettings?: ReplySettings,
	): TaskState {
		this.expireLease();
		if (this.task && !isTaskEnded(this.task.status)) {
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
		this.replySettings = replySettings ?? null;
		this.autoCountdown = null;
		this.task = {
			id: randomUUID(),
			chatId: snapshot.chatId,
			goal: goal.trim(),
			status: this.requiresVerification ? "needs_user" : "waiting",
			pendingReply: null,
			detail: this.requiresVerification
				? "The previous send may have completed. Check the conversation before resuming."
				: null,
			agentChat: [],
		};
		this.touch();
		this.lastSeenTexts.clear();
		recordSeenTexts(this.lastSeenTexts, snapshot);
		this.evaluationReason = "task_started";
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
		// Refresh the baseline without emitting: edits made while disconnected
		// surface as current text on resume, not as new corrections.
		recordSeenTexts(this.lastSeenTexts, snapshot);
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
		if (!isTaskEnded(task.status)) {
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
				this.appendAgentChat("event", `Reply edited to: ${updated}`);
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
				// Cancelling during the post-send completion check must leave the
				// task waiting, not re-run the check on the next sync.
				this.evaluationReason = "new_message";
				task.status = uncertain ? "needs_user" : "waiting";
				task.detail = uncertain
					? "The send may have completed. Check the conversation before resuming."
					: "Reply cancelled. Waiting for a new message.";
				this.appendAgentChat(
					"event",
					uncertain ? "Cancel requested; the send may have completed." : "Reply cancelled.",
				);
				break;
			}
			case "pause": {
				if (isTaskEnded(task.status)) throw new Error("This task has ended.");
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
				this.evaluationReason = "user_resumed";
				this.processedRevisions.delete(snapshot.revision);
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
			// New instructions and answers both feed the next evaluation.
			case "update-goal":
			case "answer-agent": {
				if (isTaskEnded(task.status)) throw new Error("This task has ended.");
				const value = checkedText(text);
				const wasPaused = task.status === "paused";
				const uncertain = this.invalidate(true);
				if (action === "update-goal") {
					task.goal = value;
					this.appendAgentChat("event", "Instructions updated.");
				} else {
					this.appendAgentChat("user", value);
				}
				task.pendingReply = null;
				if (uncertain || this.requiresVerification) {
					task.status = wasPaused ? "paused" : "needs_user";
					task.detail = "The send may have completed. Check the conversation before resuming.";
				} else {
					this.processedRevisions.clear();
					this.evaluationReason = "instructions_updated";
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

	sync(
		connectorId: string,
		snapshot: ConversationSnapshot | null,
		developerMode?: boolean,
		replySettings?: ReplySettings,
	): ConnectorSyncResult {
		this.expireLease();
		if (!this.task) return { task: null, isOwner: false, command: null };
		if (connectorId !== this.owner) {
			return {
				task: { ...this.state()!, goal: "", pendingReply: null, detail: null, agentChat: [] },
				isOwner: false,
				command: null,
			};
		}
		const task = this.task;
		// Ended tasks can still be viewed and deleted, but no longer accept
		// conversation updates, including requests sent before the task ended.
		if (isTaskEnded(task.status)) {
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
		// Applied before the send claim below, so the sync that switches
		// auto-send off can never hand out the reply it stops.
		if (replySettings) this.applyReplySettings(replySettings);
		const copy = structuredClone(snapshot);
		if (previous && previous.revision === copy.revision && semanticMessages(previous) !== semanticMessages(copy)) {
			this.pauseForDisconnect("The conversation could not be verified. Reopen it and resume.");
			this.connector.updateConversation(null);
			this.leaseUntil = 0;
			return { task: this.state(), isOwner: true, command: null };
		}
		// Diff plain texts by stable ID before recording this snapshot. Each
		// observed correction is emitted once, as an agent-chat event carrying
		// before/after text; first sight of an already-edited message has no
		// previous version and is labeled by its edited flag alone.
		const edits = findEdits(this.lastSeenTexts, copy);
		for (const edit of edits) this.appendEditEvent(edit);
		if (previous && previous.revision !== copy.revision) {
			// Our own outgoing bubble can land while the post-send completion
			// check is running. Re-run that check on the new snapshot instead
			// of dropping it to the outgoing guard; genuinely new incoming
			// content still invalidates into a full evaluation.
			const postSendRerun =
				task.status === "thinking" &&
				this.generation !== null &&
				this.evaluationReason === "reply_sent" &&
				latestMessage(copy)?.direction === "outgoing";
			if (!["paused", "needs_user"].includes(task.status)) {
				this.evaluationReason = edits.length ? "message_edited" : "new_message";
				if (postSendRerun) this.evaluationReason = "reply_sent";
			}
			// After authorization, a new revision can be the outgoing bubble
			// itself. Keep the attempt until its explicit report arrives.
			if (!(task.status === "sending" && this.inFlight?.authorized)) {
				const uncertain = this.invalidate();
				task.pendingReply = null;
				if (uncertain) {
					task.status = "needs_user";
					task.detail = "The send may have completed. Check the conversation before resuming.";
					this.appendAgentChat("event", "The send may have completed.");
				} else if (!["paused", "needs_user", "completed", "taken_over"].includes(task.status)) {
					task.status = "waiting";
					task.detail = null;
				}
			}
		}
		this.connector.updateConversation(copy);
		recordSeenTexts(this.lastSeenTexts, copy);
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
				if (isTaskEnded(this.task.status)) {
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
			this.appendAgentChat("event", "The reply was not sent.");
			return returnState();
		}
		this.suppressedRevisions.add(attempt.command.expectedRevision);
		this.suppressedContexts.add(attempt.context);
		if (this.task.status !== "sending") return returnState();
		if (result === "sent" && attempt.authorized) {
			this.task.status = "waiting";
			this.task.detail = "Reply sent. Waiting for a new message.";
			this.appendAgentChat("event", "Reply sent.", attempt.command.text);
			// A confirmed send ends with a one-shot completion check instead of
			// idling behind the outgoing guard. Racing incoming content keeps
			// its full evaluation, which may still reply.
			const current = this.connector.readConversation();
			const latest = current && latestMessage(current);
			if (!current || current.revision === attempt.command.expectedRevision || latest?.direction !== "incoming") {
				this.evaluationReason = "reply_sent";
			}
			this.maybeGenerate();
		} else {
			if (result !== "rejected") this.requiresVerification = true;
			this.task.status = "needs_user";
			this.task.detail =
				result === "rejected"
					? "The reply was not sent. Check the conversation before resuming."
					: "The send could not be confirmed. Check the conversation before resuming.";
			this.appendAgentChat(
				"event",
				result === "rejected" ? "The reply was not sent." : "The send could not be confirmed.",
			);
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

	private appendAgentChat(role: AgentChatRole, text: string, body: string | null = null): void {
		if (!this.task) return;
		this.task.agentChat.push({ id: randomUUID(), role, text, body, createdAt: this.now() });
		if (this.task.agentChat.length > MAX_AGENT_CHAT) {
			this.task.agentChat.splice(0, this.task.agentChat.length - MAX_AGENT_CHAT);
		}
	}

	private appendEditEvent(edit: ObservedEdit): void {
		const who =
			edit.direction === "incoming"
				? edit.sender
					? `incoming message from ${edit.sender}`
					: "incoming message"
				: edit.direction === "outgoing"
					? "outgoing message"
					: edit.direction === "unknown"
						? "message with unknown sender"
						: "message";
		const article = /^[aeiou]/i.test(who) ? "An" : "A";
		// Untrusted conversation history, like the conversation itself. The
		// current text in the snapshot is the sender's statement; the previous
		// text is only what it said before.
		this.appendAgentChat(
			"event",
			`${article} ${who} was corrected (not a new message).`,
			`Previous text: ${edit.before}\nCurrent text: ${edit.after}`,
		);
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
		this.lastSeenTexts.clear();
		this.requiresVerification = false;
		this.resumeWhenReadable = false;
		this.autoCountdown = null;
	}

	private applyReplySettings(settings: ReplySettings): void {
		this.replySettings = settings;
		const task = this.task;
		const pending = task?.pendingReply;
		if (settings.autoSend || task?.status !== "pending" || !pending || pending.commandId !== this.autoCountdown) return;
		pending.sendAt = null;
		task.detail = AUTO_SEND_OFF;
		this.autoCountdown = null;
	}

	// Null when the user sends each reply explicitly.
	private nextReplyDelayMs(): number | null {
		const settings = this.replySettings;
		if (!settings) return this.replyDelayMs;
		if (!settings.autoSend) return null;
		const { minDelaySeconds: min, maxDelaySeconds: max } = settings;
		return (min + Math.floor(this.random() * (max - min + 1))) * 1000;
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
				isTaskEnded(this.task.status)
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
				this.appendAgentChat("event", "The send could not be confirmed.");
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
		this.appendAgentChat("event", "A previous send may have completed.");
		if (isTaskEnded(this.task.status)) {
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
		if (!this.task || isTaskEnded(this.task.status)) return;
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
		// The post-send completion check runs once despite suppression: the
		// sent context is suppressed against re-replies, not against finish.
		if (
			this.evaluationReason !== "reply_sent" &&
			(this.processedRevisions.has(snapshot.revision) ||
				this.suppressedRevisions.has(snapshot.revision) ||
				this.suppressedContexts.has(textContext(snapshot)))
		)
			return;
		// An unsent group event still withdraws the message before it.
		const latest = latestMessage(snapshot);
		if (latest?.unsent) {
			task.status = "needs_user";
			task.detail = "The latest message was unsent. Check the conversation before resuming.";
			return;
		}
		if ((!latest || latest.direction === "outgoing") && this.evaluationReason === "new_message") {
			task.detail = "Waiting for a new incoming message.";
			return;
		}
		if (latest?.direction === "unknown") {
			task.status = "needs_user";
			task.detail = "The latest message has an unknown sender. Check the conversation before resuming.";
			return;
		}
		if (latest && !readableLatest(snapshot.messages, latest)) {
			task.status = "needs_user";
			// Quote bytes never reach the model, so a quoted attachment always
			// causes this pause. Name it: the general message hides what happened.
			const quoted = latest.replyTo?.attachments ?? [];
			task.detail = !quoted.length
				? "The latest message contains content Envoy cannot interpret."
				: quoted.every((attachment) => attachment.type === "image")
					? "The latest message quotes an image Envoy cannot read. Take over to reply yourself."
					: "The latest message quotes media Envoy cannot read. Take over to reply yourself.";
			return;
		}
		task.status = "thinking";
		task.detail =
			this.evaluationReason === "reply_sent" ? "Checking if the task is complete." : "Considering the conversation.";
		const epoch = ++this.epoch;
		const reason = this.evaluationReason;
		const abort = new AbortController();
		this.generation = abort;
		const captured = structuredClone(snapshot);
		const taskCopy = this.state()!;
		void this.agent.run(taskCopy, captured, reason, abort.signal).then(
			(decision) => this.acceptDecision(epoch, captured, reason, decision),
			() => {
				if (this.epoch !== epoch || !this.task || this.task.status !== "thinking") return;
				this.generation = null;
				// A failed completion check must not block the user over a send
				// that already succeeded: degrade to waiting, never needs_user.
				if (reason === "reply_sent") {
					this.processedRevisions.add(captured.revision);
					this.evaluationReason = "new_message";
					this.task.status = "waiting";
					this.task.detail = "Reply sent. Waiting for a new message.";
					return;
				}
				this.task.status = "needs_user";
				this.task.detail = process.env.MODEL_API_KEY?.trim()
					? "The model could not produce a decision. Check its configuration and resume."
					: "Set MODEL_API_KEY on the backend and resume.";
			},
		);
	}

	private acceptDecision(
		epoch: number,
		snapshot: ConversationSnapshot,
		reason: EvaluationReason,
		decision: AgentDecision,
	): void {
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
		// The post-send check runs once: consume the reason so later syncs fall
		// back to the outgoing guard instead of re-evaluating.
		if (reason === "reply_sent") this.evaluationReason = "new_message";
		switch (decision.action) {
			case "reply": {
				// A reply after a confirmed send would double-send. Treat it as
				// invalid and wait instead; never create a pending reply here.
				if (reason === "reply_sent") {
					task.status = "waiting";
					task.detail = "Reply sent. Waiting for a new message.";
					break;
				}
				let text: string;
				try {
					text = checkedReply(decision.text);
					if (this.developerMode) text = checkedReply(`> ${text}`);
				} catch {
					task.status = "needs_user";
					task.detail = "The model returned an invalid reply. Check the conversation.";
					return;
				}
				const delay = this.nextReplyDelayMs();
				const pending: PendingReply = {
					commandId: randomUUID(),
					chatId: task.chatId,
					expectedRevision: snapshot.revision,
					text,
					sendAt: delay === null ? null : this.now() + delay,
				};
				task.pendingReply = pending;
				task.status = "pending";
				task.detail = delay === null ? AUTO_SEND_OFF : "Review the reply before it sends.";
				this.autoCountdown = delay === null ? null : pending.commandId;
				break;
			}
			case "wait":
				task.status = "waiting";
				task.detail =
					reason === "reply_sent" ? "Reply sent. Waiting for a new message." : "Waiting for a new message.";
				break;
			case "ask":
				// Uncertainty after a send resolves to waiting: any later message
				// re-evaluates, so asking would only interrupt the user.
				if (reason === "reply_sent") {
					task.status = "waiting";
					task.detail = "Reply sent. Waiting for a new message.";
					break;
				}
				task.status = "needs_user";
				task.detail = decision.text;
				this.appendAgentChat("agent", decision.text);
				break;
			case "finish":
				task.status = "completed";
				task.detail = decision.text;
				this.appendAgentChat("agent", decision.text);
				this.scheduleRetention(task.id);
				break;
		}
	}
}

function checkedText(value: string | undefined): string {
	const text = value?.trim();
	if (!text || text.length > MAX_TASK_TEXT_LENGTH)
		throw new Error(`Enter text between 1 and ${MAX_TASK_TEXT_LENGTH} characters.`);
	return text;
}

function checkedReply(value: string | undefined): string {
	if (value && hasControlCharacters(value)) {
		throw new Error("Replies must be a single line without control characters.");
	}
	return checkedText(value);
}

function latestMessage(snapshot: ConversationSnapshot): ConversationMessage | undefined {
	return [...snapshot.messages].reverse().find((message) => message.direction !== "system" || message.unsent);
}

function readableLatest(messages: readonly ConversationMessage[], latest: ConversationMessage): boolean {
	// Only forwarded media reads as content. Anything else attached (files,
	// sourceless media), or media past the per-snapshot cap, still pauses for
	// the user.
	const slots = forwardableMediaSlots(messages);
	const index = messages.indexOf(latest);
	if (
		!latest.attachments.every(
			(attachment, position) =>
				(attachment.type === "image" ||
					attachment.type === "video" ||
					attachment.type === "gif" ||
					attachment.type === "sticker") &&
				slots[index]?.[position],
		)
	)
		return false;
	if (!latest.text.trim() && !latest.attachments.length) return false;
	const quote = latest.replyTo;
	return !quote || !(quote.attachments.length || !quote.text?.trim() || !quote.context?.trim());
}

function semanticMessages(snapshot: ConversationSnapshot): string {
	// Sender labels are attribution-only metadata outside the revision. A
	// loading rename must not read as unverifiable content at the same revision.
	// Inline bytes are transport, not content: the same photo re-encoded must
	// not read as unverifiable either.
	return JSON.stringify(snapshot.messages.map(messageContent));
}

// Reactions and other cosmetic DOM changes must not trigger another reply to
// the same text after a send or cancellation.
function textContext(snapshot: ConversationSnapshot): string {
	const contents = JSON.stringify(
		snapshot.messages.map(({ direction, text, replyTo, unsent }) => ({ direction, text, replyTo, unsent })),
	);
	return createHash("sha256").update(contents).digest("hex");
}

type ObservedEdit = {
	before: string;
	after: string;
	direction: ConversationMessage["direction"];
	sender: string | null;
};

function stableKey(message: ConversationMessage): string | null {
	const stable = message.stableId?.trim();
	return stable ? stable : null;
}

// Plain text messages only. Captions and attachment edits were not tested,
// so messages with attachments, withdrawals, and system events are never
// matched for before/after text.
function trackable(message: ConversationMessage): string | null {
	const stable = stableKey(message);
	if (!stable || message.attachments.length || message.unsent || message.direction === "system") return null;
	return stable;
}

function stableCounts(snapshot: ConversationSnapshot): Map<string, number> {
	const counts = new Map<string, number>();
	for (const message of snapshot.messages) {
		const stable = stableKey(message);
		if (!stable) continue;
		counts.set(stable, (counts.get(stable) ?? 0) + 1);
	}
	return counts;
}

function findEdits(lastSeen: ReadonlyMap<string, string>, snapshot: ConversationSnapshot): ObservedEdit[] {
	const counts = stableCounts(snapshot);
	const edits: ObservedEdit[] = [];
	for (const message of snapshot.messages) {
		const stable = trackable(message);
		if (!stable || counts.get(stable) !== 1) continue;
		const before = lastSeen.get(stable);
		if (before === undefined || before === message.text) continue;
		edits.push({ before, after: message.text, direction: message.direction, sender: message.sender ?? null });
	}
	return edits;
}

function recordSeenTexts(lastSeen: Map<string, string>, snapshot: ConversationSnapshot): void {
	const counts = stableCounts(snapshot);
	for (const message of snapshot.messages) {
		const stable = stableKey(message);
		if (!stable || counts.get(stable) !== 1) {
			if (stable) lastSeen.delete(stable);
			continue;
		}
		const tracked = trackable(message);
		if (!tracked) {
			lastSeen.delete(stable);
			continue;
		}
		lastSeen.set(tracked, message.text);
	}
}
