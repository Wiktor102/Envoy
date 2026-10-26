import type { ConversationSnapshot, SendReplyCommand, SendResult, TaskControlAction, TaskState } from "@envoy/contracts";
import { callBackend } from "./messaging";
import { messengerChatAdapter, type MessengerChatAdapter } from "./messenger/chat-adapter";
import { watchConversation } from "./ui/conversation";

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
	let state: ControllerState = {
		snapshot: null,
		conversationStatus: "Open a conversation to read its messages.",
		task: null,
		isOwner: false,
		error: null,
	};
	const listeners = new Set<(state: ControllerState) => void>();
	let epoch = 0;
	let actionInFlight = false;
	let activeAction: Promise<TaskState | null> | null = null;
	let stopped = false;
	let suspended = false;
	let lifecycleVersion = 0;
	let controlsAvailable = false;
	let controlsLossVersion = 0;
	let reportedLossVersion = 0;
	let disconnectPromise: Promise<void> | null = null;
	let syncRequested = false;
	let syncPromise: Promise<void> | null = null;
	const claimed = new Set<string>();

	function publish(patch: Partial<ControllerState>) {
		state = { ...state, ...patch };
		for (const listener of listeners) listener(state);
	}

	function identity(snapshot: ConversationSnapshot | null): string | null {
		return snapshot ? `${snapshot.chatId}:${snapshot.revision}` : null;
	}

	async function execute(command: SendReplyCommand, commandEpoch: number) {
		if (claimed.has(command.commandId)) return;
		claimed.add(command.commandId);
		let result: SendResult = "rejected";
		const isCurrent = () =>
			!stopped &&
			!suspended &&
			controlsAvailable &&
			!actionInFlight &&
			epoch === commandEpoch &&
			identity(state.snapshot) === `${command.chatId}:${command.expectedRevision}`;
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
			if (!stopped) publish({ error: "Could not report the send result. Check Messenger before taking over." });
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
				const lossVersion = controlsLossVersion;
				const reportingLoss = state.isOwner && lossVersion !== reportedLossVersion;
				try {
					// Other tabs only discover task status. They never upload their messages.
					const result = await transport({
						type: "envoy:sync",
						snapshot: state.isOwner && controlsAvailable && !reportingLoss ? state.snapshot : null,
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
					if (result.command) void execute(result.command, requestEpoch);
				} catch {
					if (!stopped) publish({ error: "Backend connection unavailable. Pending sends will pause." });
				}
			}
		})().finally(() => {
			syncPromise = null;
			if (syncRequested && !actionInFlight) requestSync();
		});
	}

	const stopWatching = watch((snapshot, conversationStatus) => {
		if (identity(snapshot) !== identity(state.snapshot)) epoch++;
		const changed = identity(snapshot) !== identity(state.snapshot);
		publish({ snapshot, conversationStatus });
		if (changed && state.isOwner) requestSync();
	});
	const interval = setInterval(requestSync, 1_000);
	requestSync();

	async function runAction(action: () => Promise<TaskState | null>) {
		if (actionInFlight || stopped || suspended)
			throw new Error("The tab is unavailable or another action is in progress.");
		actionInFlight = true;
		epoch++;
		try {
			// Do not let an older heartbeat overtake a newly started task.
			if (syncPromise) await syncPromise;
			if (stopped || suspended || !controlsAvailable) throw new Error("The Envoy controls are unavailable.");
			activeAction = action();
			const task = await activeAction;
			if (!stopped && !suspended) publish({ task, isOwner: task !== null, error: null });
		} catch (error) {
			if (!stopped) publish({ error: error instanceof Error ? error.message : "The action failed." });
			throw error;
		} finally {
			activeAction = null;
			actionInFlight = false;
			requestSync();
		}
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
		void disconnectAfterOutstandingWork();
	};
	const onPageShow = () => {
		if (!suspended || stopped) return;
		const showVersion = ++lifecycleVersion;
		void (async () => {
			if (disconnectPromise) await disconnectPromise;
			if (stopped || lifecycleVersion !== showVersion) return;
			suspended = false;
			requestSync();
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
				if (!current) throw new Error("Open a conversation and wait for it to load.");
				const fresh = await adapter.readConversation();
				if (
					stopped ||
					suspended ||
					!controlsAvailable ||
					identity(fresh) !== identity(current) ||
					identity(state.snapshot) !== identity(current)
				) {
					throw new Error("The conversation changed. Try again once it has loaded.");
				}
				return transport({ type: "envoy:start", goal, snapshot: fresh });
			});
		},
		async attach() {
			await runAction(async () => {
				const current = state.snapshot;
				const task = state.task;
				if (!current || !task || current.chatId !== task.chatId) {
					throw new Error("Open the task's conversation before reconnecting.");
				}
				const fresh = await adapter.readConversation();
				if (
					stopped ||
					suspended ||
					!controlsAvailable ||
					identity(fresh) !== identity(current) ||
					identity(state.snapshot) !== identity(current)
				) {
					throw new Error("The conversation changed. Try again once it has loaded.");
				}
				return transport({ type: "envoy:attach", taskId: task.id, snapshot: fresh });
			});
		},
		async control(action, text) {
			await runAction(async () => {
				if (!state.task || !state.isOwner) throw new Error("This tab does not control the task.");
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
				if (!state.task) throw new Error("There is no task to delete.");
				await transport({ type: "envoy:clear", taskId: state.task.id });
				return null;
			});
		},
		checkHealth: () => transport({ type: "envoy:health" }),
		setControlsAvailable(available) {
			if (controlsAvailable === available) return;
			controlsAvailable = available;
			if (!available && (state.isOwner || actionInFlight)) controlsLossVersion++;
			epoch++;
			if (state.isOwner) requestSync();
		},
		destroy() {
			if (stopped) return;
			stopped = true;
			epoch++;
			stopWatching();
			clearInterval(interval);
			lifecycle.removeEventListener("pagehide", onPageHide);
			lifecycle.removeEventListener("pageshow", onPageShow);
			listeners.clear();
			void disconnectAfterOutstandingWork();
		},
	};
}
