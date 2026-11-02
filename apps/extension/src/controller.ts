import { isTaskEnded } from "@envoy/contracts";
import type { ConversationSnapshot, SendReplyCommand, SendResult, TaskControlAction, TaskState } from "@envoy/contracts";
import { detectLocale, getStrings, loadedMessagesText } from "./i18n";
import { callBackend } from "./messaging";
import { messengerChatAdapter, type MessengerChatAdapter } from "./messenger/chat-adapter";
import { conversationErrorStatus, watchConversation } from "./ui/conversation";
import { startOwnerHeartbeat, type StartOwnerHeartbeat } from "./heartbeat";

export interface ControllerState {
	snapshot: ConversationSnapshot | null;
	conversationStatus: string;
	task: TaskState | null;
	isOwner: boolean;
	error: string | null;
}

export interface EnvoyController {
	subscribe(listener: (state: ControllerState) => void): () => void;
	start(goal: string): Promise<void>;
	attach(): Promise<void>;
	clear(): Promise<void>;
	control(action: TaskControlAction, text?: string): Promise<void>;
	checkHealth(): Promise<boolean>;
	setControlsAvailable(available: boolean): void;
}

interface ControllerDependencies {
	transport: typeof callBackend;
	adapter: MessengerChatAdapter;
	watch: typeof watchConversation;
	lifecycle: Pick<EventTarget, "addEventListener" | "removeEventListener">;
	heartbeat: StartOwnerHeartbeat;
}

// This object belongs to one document. The server owns task state; the document
// only watches its chat and executes a command after a fresh authorization.
export function createEnvoyController(
	dependencies: Partial<ControllerDependencies> = {},
): EnvoyController & { destroy(): void } {
	const transport = dependencies.transport ?? callBackend;
	const adapter = dependencies.adapter ?? messengerChatAdapter;
	const watch = dependencies.watch ?? watchConversation;
	const lifecycle = dependencies.lifecycle ?? window;
	const heartbeat = dependencies.heartbeat ?? startOwnerHeartbeat;
	let state: ControllerState = {
		snapshot: null,
		conversationStatus: getStrings().openConversation,
		task: null,
		isOwner: false,
		error: null,
	};
	const listeners = new Set<(state: ControllerState) => void>();
	let epoch = 0;
	let sendVersion = 0;
	let actionInFlight = false;
	let activeAction: Promise<TaskState | null> | null = null;
	let stopped = false;
	let suspended = false;
	let lifecycleVersion = 0;
	let controlsAvailable = false;
	let unavailableVersion = 0;
	let reportedLossVersion = 0;
	let connectionLossVersion = 0;
	let reportedConnectionLossVersion = 0;
	let disconnectPromise: Promise<void> | null = null;
	let syncRequested = false;
	let syncPromise: Promise<void> | null = null;
	let stopHeartbeat: (() => void) | null = null;
	let refreshRequested = false;
	let refreshPromise: Promise<void> | null = null;
	const claimed = new Set<string>();

	// Backend revocations must survive a later return to sending. A delayed
	// authorization belongs only to the task and send that requested it.
	function authorizationScopeChanged(previous: ControllerState, next: ControllerState): boolean {
		return (
			previous.task?.id !== next.task?.id ||
			previous.task?.chatId !== next.task?.chatId ||
			previous.isOwner !== next.isOwner ||
			(previous.task?.status === "sending" && next.task?.status !== "sending")
		);
	}

	function publish(patch: Partial<ControllerState>) {
		const next = { ...state, ...patch };
		if (authorizationScopeChanged(state, next)) {
			sendVersion++;
		}
		state = next;
		for (const listener of listeners) listener(state);
	}

	function identity(snapshot: ConversationSnapshot | null): string | null {
		return snapshot ? `${snapshot.chatId}:${snapshot.revision}` : null;
	}

	function commandIdentity(command: SendReplyCommand): string {
		return `${command.chatId}:${command.expectedRevision}`;
	}

	function observe(snapshot: ConversationSnapshot | null, conversationStatus: string) {
		const changed = identity(snapshot) !== identity(state.snapshot);
		// A transient unavailable read must reach the backend even if a later
		// read succeeds while an older sync is still in flight.
		if (changed && snapshot === null && state.isOwner) unavailableVersion++;
		if (changed) epoch++;
		publish({ snapshot, conversationStatus });
		if (changed && state.isOwner) requestSync();
	}

	function ownerAvailable(): boolean {
		return Boolean(
			!stopped && !suspended && controlsAvailable && state.isOwner && state.task && !isTaskEnded(state.task.status),
		);
	}

	function stopOwnerHeartbeat() {
		const stop = stopHeartbeat;
		stopHeartbeat = null;
		stop?.();
	}

	function reconcileHeartbeat() {
		if (!ownerAvailable()) {
			stopOwnerHeartbeat();
			return;
		}
		if (stopHeartbeat) return;
		try {
			stopHeartbeat = heartbeat(requestFreshSync, () => {
				stopHeartbeat = null;
				if (!ownerAvailable()) return;
				// A lost port cannot prove the tab is still receiving changes.
				// Disconnect before any later read can resume the task automatically.
				connectionLossVersion++;
				observe(null, getStrings().connectionInterrupted);
				requestSync();
			});
		} catch {
			// The normal timer provides a fallback and the server lease expires
			// safely if the browser worker cannot be reached.
			stopHeartbeat = null;
		}
	}

	function requestFreshSync() {
		if (!ownerAvailable()) return;
		refreshRequested = true;
		if (refreshPromise || actionInFlight) return;
		refreshPromise = (async () => {
			while (refreshRequested && ownerAvailable() && !actionInFlight) {
				refreshRequested = false;
				const readEpoch = epoch;
				let snapshot: ConversationSnapshot | null;
				let status = conversationErrorStatus(null);
				try {
					snapshot = await adapter.readConversation();
				} catch (error) {
					snapshot = null;
					status = conversationErrorStatus(error);
				}
				if (!ownerAvailable()) return;
				if (readEpoch !== epoch || actionInFlight) {
					// The watcher or a user action changed state during the read.
					// Never let an older read overwrite the latest snapshot.
					refreshRequested = true;
					continue;
				}
				observe(snapshot, snapshot ? loadedMessagesText(detectLocale(), snapshot.messages.length) : status);
				requestSync();
			}
		})().finally(() => {
			refreshPromise = null;
			if (refreshRequested && !actionInFlight) requestFreshSync();
		});
	}

	async function execute(command: SendReplyCommand, commandEpoch: number) {
		if (claimed.has(command.commandId)) return;
		claimed.add(command.commandId);
		let result: SendResult = "rejected";
		const taskId = state.task?.id;
		const commandVersion = sendVersion;
		// ownerAvailable covers the stopped/suspended/controls/owner/task checks;
		// "sending" below implies the remaining liveness checks.
		const isCurrent = () =>
			ownerAvailable() &&
			!actionInFlight &&
			epoch === commandEpoch &&
			sendVersion === commandVersion &&
			state.task?.id === taskId &&
			state.task?.status === "sending" &&
			state.task.chatId === command.chatId &&
			identity(state.snapshot) === commandIdentity(command);
		try {
			if (isCurrent())
				result = await adapter.sendReply(
					command,
					async () => {
						if (!isCurrent()) return false;
						const authorized = await transport({
							type: "envoy:authorize",
							commandId: command.commandId,
							chatId: command.chatId,
							revision: command.expectedRevision,
						});
						return authorized && isCurrent();
					},
					isCurrent,
				);
		} catch {
			// Once dispatch may have happened, an exception cannot safely be retried.
			result = "uncertain";
		}
		try {
			await transport({ type: "envoy:report", commandId: command.commandId, result });
		} catch {
			if (!stopped) publish({ error: getStrings().reportFailed });
		}
		requestSync();
	}

	function requestSync() {
		if (stopped || suspended) return;
		syncRequested = true;
		if (syncPromise || actionInFlight) return;
		syncPromise = (async () => {
			while (syncRequested && !stopped && !suspended && !actionInFlight) {
				syncRequested = false;
				const requestEpoch = epoch;
				const lossVersion = unavailableVersion;
				const reportingLoss = state.isOwner && lossVersion !== reportedLossVersion;
				const connectionVersion = connectionLossVersion;
				try {
					if (state.isOwner && connectionVersion !== reportedConnectionLossVersion) {
						// Null snapshots allow recovery from read failures. Losing the
						// controls or heartbeat must instead require an explicit resume.
						// Do not send another snapshot until the disconnect is confirmed.
						await transport({ type: "envoy:disconnect" });
						reportedConnectionLossVersion = connectionVersion;
						syncRequested = true;
						continue;
					}
					// Other tabs and ended tasks only discover task status.
					const result = await transport({
						type: "envoy:sync",
						snapshot: ownerAvailable() && !reportingLoss ? state.snapshot : null,
					});
					if (reportingLoss) reportedLossVersion = lossVersion;
					if (stopped) return;
					if (requestEpoch !== epoch || actionInFlight) {
						// A returned command is claimed on the server. Report it even if
						// a local change made it impossible to authorize.
						if (result.command) void execute(result.command, requestEpoch);
						syncRequested = true;
						continue;
					}
					publish({ task: result.task, isOwner: result.isOwner, error: null });
					reconcileHeartbeat();
					if (result.command) void execute(result.command, requestEpoch);
				} catch {
					if (!stopped) publish({ error: getStrings().backendDown });
				}
			}
		})().finally(() => {
			syncPromise = null;
			if (syncRequested && !actionInFlight) requestSync();
		});
	}

	const stopWatching = watch((snapshot, conversationStatus) => {
		if (!stopped && !suspended) observe(snapshot, conversationStatus);
	});
	// Fallback pump when the heartbeat port cannot reach the background worker.
	const POLL_MS = 1_000;
	const interval = setInterval(() => {
		reconcileHeartbeat();
		if (ownerAvailable()) requestFreshSync();
		else requestSync();
	}, POLL_MS);
	requestSync();

	async function runAction(action: () => Promise<TaskState | null>) {
		if (actionInFlight || stopped || suspended) throw new Error(getStrings().tabBusy);
		actionInFlight = true;
		epoch++;
		try {
			// Do not let an older heartbeat overtake a newly started task.
			if (syncPromise) await syncPromise;
			if (stopped || suspended || !controlsAvailable) throw new Error(getStrings().controlsUnavailable);
			activeAction = action();
			const task = await activeAction;
			if (!stopped && !suspended) {
				publish({ task, isOwner: task !== null, error: null });
				reconcileHeartbeat();
			}
		} catch (error) {
			if (!stopped) publish({ error: error instanceof Error ? error.message : getStrings().actionFailed });
			throw error;
		} finally {
			activeAction = null;
			actionInFlight = false;
			if (refreshRequested) requestFreshSync();
			requestSync();
		}
	}

	// Re-read before starting or attaching, so the request carries exactly the
	// conversation the user saw and still controls.
	async function readUnchanged(current: ConversationSnapshot): Promise<ConversationSnapshot> {
		const fresh = await adapter.readConversation();
		if (
			stopped ||
			suspended ||
			!controlsAvailable ||
			identity(fresh) !== identity(current) ||
			identity(state.snapshot) !== identity(current)
		) {
			throw new Error(getStrings().conversationChanged);
		}
		return fresh;
	}

	function disconnectAfterOutstandingWork(): Promise<void> {
		if (disconnectPromise) return disconnectPromise;
		const pendingSync = syncPromise;
		const pendingAction = activeAction;
		disconnectPromise = (async () => {
			if (pendingSync) await pendingSync.catch(() => {});
			if (pendingAction) await pendingAction.catch(() => {});
			await transport({ type: "envoy:disconnect" }).catch(() => {});
		})().finally(() => {
			disconnectPromise = null;
		});
		return disconnectPromise;
	}

	const onPageHide = () => {
		suspended = true;
		lifecycleVersion++;
		epoch++;
		stopOwnerHeartbeat();
		publish({ snapshot: null });
		void disconnectAfterOutstandingWork();
	};
	const onPageShow = () => {
		if (!suspended || stopped) return;
		const showVersion = ++lifecycleVersion;
		void (async () => {
			if (disconnectPromise) await disconnectPromise;
			if (stopped || lifecycleVersion !== showVersion) return;
			suspended = false;
			reconcileHeartbeat();
			if (ownerAvailable()) requestFreshSync();
			else requestSync();
		})();
	};
	lifecycle.addEventListener("pagehide", onPageHide);
	lifecycle.addEventListener("pageshow", onPageShow);

	return {
		subscribe(listener) {
			listeners.add(listener);
			listener(state);
			return () => listeners.delete(listener);
		},
		async start(goal) {
			await runAction(async () => {
				const current = state.snapshot;
				if (!current) throw new Error(getStrings().openAndWait);
				const fresh = await readUnchanged(current);
				return transport({ type: "envoy:start", goal, snapshot: fresh });
			});
		},
		async attach() {
			await runAction(async () => {
				const current = state.snapshot;
				const task = state.task;
				if (!current || !task || current.chatId !== task.chatId) {
					throw new Error(getStrings().openTaskChat);
				}
				const fresh = await readUnchanged(current);
				return transport({ type: "envoy:attach", taskId: task.id, snapshot: fresh });
			});
		},
		async control(action, text) {
			await runAction(async () => {
				if (!state.task || !state.isOwner) throw new Error(getStrings().notOwner);
				return transport({
					type: "envoy:control",
					taskId: state.task.id,
					action,
					...(text === undefined ? {} : { text }),
				});
			});
		},
		async clear() {
			await runAction(async () => {
				if (!state.task) throw new Error(getStrings().noTaskToDelete);
				await transport({ type: "envoy:clear", taskId: state.task.id });
				return null;
			});
		},
		checkHealth: () => transport({ type: "envoy:health" }),
		setControlsAvailable(available) {
			if (controlsAvailable === available) return;
			controlsAvailable = available;
			if (!available && (state.isOwner || actionInFlight)) connectionLossVersion++;
			epoch++;
			reconcileHeartbeat();
			if (state.isOwner) requestSync();
		},
		destroy() {
			if (stopped) return;
			stopped = true;
			epoch++;
			stopOwnerHeartbeat();
			stopWatching();
			clearInterval(interval);
			lifecycle.removeEventListener("pagehide", onPageHide);
			lifecycle.removeEventListener("pageshow", onPageShow);
			listeners.clear();
			void disconnectAfterOutstandingWork();
		},
	};
}
