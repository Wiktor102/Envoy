import { DEFAULT_REPLY_DELAY_SECONDS, type TaskControlAction, type TaskStatus } from "@envoy/contracts";
import type { ControllerState, EnvoyController } from "../controller";
import { isolateTextInput } from "./text-input";
import styles from "./styles.css?inline";
import markup from "./view.html?raw";

const statusLabels: Record<TaskStatus, string> = {
	thinking: "Thinking",
	waiting: "Waiting for a new message",
	pending: "Reply ready",
	editing: "Reply paused for editing",
	sending: "Sending reply",
	paused: "Paused",
	needs_user: "Needs your input",
	completed: "Completed",
	taken_over: "Taken over",
};

// Markup is static. Conversation and model text are inserted as text, never HTML.
export function createEnvoyView(onSelectionChange: () => void, controller: EnvoyController) {
	const host = document.createElement("envoy-root");
	if (location.hostname === "facebook.com" || location.hostname.endsWith(".facebook.com")) {
		host.setAttribute("data-facebook", "");
	}

	// Facebook marks its active theme on <html>; CSS falls back to the system theme.
	function syncTheme() {
		const classes = document.documentElement.classList;
		const theme = classes.contains("__fb-dark-mode") ? "dark" : classes.contains("__fb-light-mode") ? "light" : null;
		if (theme) host.setAttribute("data-theme", theme);
		else host.removeAttribute("data-theme");
	}
	syncTheme();
	const themeObserver = new MutationObserver(syncTheme);
	themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

	const shadow = host.attachShadow({ mode: "closed" });
	const style = document.createElement("style");
	style.textContent = styles;
	const container = document.createElement("div");
	container.innerHTML = markup;
	shadow.append(style, container);

	function element<T extends HTMLElement>(selector: string): T {
		const result = container.querySelector<T>(selector);
		if (!result) throw new Error(`Missing Envoy UI element: ${selector}`);
		return result;
	}

	const chatsTab = element<HTMLButtonElement>("#chats-tab");
	const envoyTab = element<HTMLButtonElement>("#envoy-tab");
	const panel = element<HTMLElement>("#envoy-panel");
	const developerToggle = element<HTMLButtonElement>("#envoy-developer-mode");
	const developerDetails = element<HTMLElement>("#envoy-developer-details");
	const chatId = element<HTMLElement>("#envoy-chat-id");
	const conversationStatus = element<HTMLElement>("#envoy-conversation-status");
	const conversationNotice = element<HTMLElement>("#envoy-conversation-notice");
	const conversation = element<HTMLOListElement>("#envoy-conversation");
	const conversationEmpty = element<HTMLElement>("#envoy-conversation-empty");
	const header = element<HTMLElement>("#envoy-header");
	const goalToggle = element<HTMLButtonElement>("#envoy-goal-toggle");
	const goalText = element<HTMLElement>("#envoy-goal-text");
	const instructions = element<HTMLElement>("#envoy-instructions");
	const thread = element<HTMLElement>("#envoy-thread");
	const footer = element<HTMLElement>("#envoy-footer");
	const goal = element<HTMLTextAreaElement>("#envoy-goal");
	const goalHint = element<HTMLElement>("#envoy-goal-hint");
	const startButton = element<HTMLButtonElement>("#envoy-start");
	const updateGoalButton = element<HTMLButtonElement>("#envoy-update-goal");
	const taskId = element<HTMLElement>("#envoy-task-id");
	const taskChat = element<HTMLElement>("#envoy-task-chat");
	const taskNotice = element<HTMLElement>("#envoy-task-notice");
	const agentState = element<HTMLElement>("#envoy-agent-state");
	const agentEmpty = element<HTMLElement>("#envoy-agent-empty");
	const agentMessages = element<HTMLOListElement>("#envoy-agent-messages");
	const answerText = element<HTMLTextAreaElement>("#envoy-answer-text");
	const answerSend = element<HTMLButtonElement>("#envoy-answer-send");
	const pendingSection = element<HTMLElement>("#envoy-pending");
	const pendingText = element<HTMLElement>("#envoy-pending-text");
	const countdown = element<HTMLElement>("#envoy-countdown");
	const editor = element<HTMLElement>("#envoy-editor");
	const editText = element<HTMLTextAreaElement>("#envoy-reply-edit");
	isolateTextInput(goal);
	isolateTextInput(editText);
	isolateTextInput(answerText);
	const saveEditButton = element<HTMLButtonElement>("#envoy-save-edit");
	const replyControls = element<HTMLElement>("#envoy-reply-controls");
	const cancelThinking = element<HTMLButtonElement>("#envoy-cancel-thinking");
	const sendButton = element<HTMLButtonElement>("#envoy-send-now");
	const editButton = element<HTMLButtonElement>("#envoy-edit");
	const cancelButton = element<HTMLButtonElement>("#envoy-cancel");
	const pauseButton = element<HTMLButtonElement>("#envoy-pause");
	const resumeButton = element<HTMLButtonElement>("#envoy-resume");
	const reconnectButton = element<HTMLButtonElement>("#envoy-reconnect");
	const takeoverButton = element<HTMLButtonElement>("#envoy-take-over");
	const deleteButton = element<HTMLButtonElement>("#envoy-delete");
	const ownerHint = element<HTMLElement>("#envoy-owner-hint");
	const deleteHint = element<HTMLElement>("#envoy-delete-hint");
	const error = element<HTMLElement>("#envoy-error");
	const healthButton = element<HTMLButtonElement>("#envoy-health");
	const healthStatus = element<HTMLElement>("#envoy-health-status");

	let state: ControllerState = {
		snapshot: null,
		conversationStatus: "Open a conversation to read its messages.",
		task: null,
		isOwner: false,
		error: null,
	};
	let busy = false;
	let destroyed = false;
	let localError: string | null = null;
	let displayedTaskId: string | null = null;
	let displayedTaskOwner = false;
	let goalDirty = false;
	let goalEditorOpen = false;
	let lastChatCount = 0;
	let lastPendingKey: string | null = null;
	let editingCommandId: string | null = null;
	// The backend clears the pending reply once it hands it to the tab.
	let sendingReply: { taskId: string; text: string } | null = null;
	let renderedConversation: string | null = null;
	let renderedAgentChat: string | null = null;
	const openToolCalls = new Set<string>();
	let developerMode = false;
	let developerModeChanged = false;
	let preferenceWrite = Promise.resolve();

	function setDeveloperMode(enabled: boolean) {
		developerMode = enabled;
		developerToggle.setAttribute("aria-checked", String(enabled));
		developerDetails.hidden = !enabled;
	}

	async function restoreDeveloperMode() {
		try {
			const saved = await chrome.storage.local.get("envoyDeveloperMode");
			// A slow storage read must not undo a choice made in this view.
			if (!destroyed && !developerModeChanged) setDeveloperMode(saved.envoyDeveloperMode === true);
		} catch {
			// Keep diagnostics off if extension storage is unavailable.
		}
	}

	developerToggle.addEventListener("click", () => {
		developerModeChanged = true;
		const enabled = !developerMode;
		setDeveloperMode(enabled);
		// Preserve the last choice even when storage writes complete slowly.
		preferenceWrite = preferenceWrite.then(async () => {
			try {
				await chrome.storage.local.set({ envoyDeveloperMode: enabled });
			} catch {
				// The toggle still works for this view if saving is unavailable.
			}
		});
	});

	function selectTab(showEnvoy: boolean) {
		chatsTab.setAttribute("aria-selected", String(!showEnvoy));
		envoyTab.setAttribute("aria-selected", String(showEnvoy));
		chatsTab.tabIndex = showEnvoy ? -1 : 0;
		envoyTab.tabIndex = showEnvoy ? 0 : -1;
		panel.hidden = !showEnvoy;
		developerToggle.hidden = !showEnvoy;
		onSelectionChange();
	}

	chatsTab.addEventListener("click", () => selectTab(false));
	envoyTab.addEventListener("click", () => selectTab(true));
	envoyTab.tabIndex = -1;
	element<HTMLElement>(".tabs").addEventListener("keydown", (event) => {
		const keyEvent = event as KeyboardEvent;
		if (keyEvent.key !== "ArrowLeft" && keyEvent.key !== "ArrowRight") return;
		keyEvent.preventDefault();
		const showEnvoy = keyEvent.key === "ArrowRight";
		selectTab(showEnvoy);
		(showEnvoy ? envoyTab : chatsTab).focus();
	});

	function renderConversation() {
		const snapshot = state.snapshot;
		chatId.textContent = snapshot ? `Chat: ${snapshot.chatId}` : "No conversation selected.";
		conversationStatus.textContent = state.conversationStatus;
		conversationNotice.textContent = snapshot ? "" : state.conversationStatus;
		conversationNotice.hidden = Boolean(snapshot);
		conversationEmpty.hidden = Boolean(snapshot?.messages.length);
		const key = snapshot ? JSON.stringify([snapshot.chatId, snapshot.revision]) : null;
		if (key === renderedConversation) return;
		renderedConversation = key;
		conversation.replaceChildren();
		if (!snapshot) return;

		for (const message of snapshot.messages.slice(-5)) {
			const item = document.createElement("li");
			item.dataset.direction = message.direction;
			const sender = document.createElement("strong");
			sender.textContent =
				message.direction === "outgoing"
					? "You"
					: message.direction === "incoming"
						? "Other person"
						: message.direction === "system"
							? "System"
							: "Unknown sender";
			const text = document.createElement("span");
			text.className = "message-text";
			text.dir = "auto";
			text.textContent = message.unsent
				? "[Unsent message]"
				: message.text || (message.attachments.length ? "[Attachment]" : "[Empty message]");
			item.append(sender, text);
			conversation.append(item);
		}
	}

	function renderCountdown() {
		const task = state.task;
		if (task?.status === "sending") {
			countdown.textContent = "Sending...";
		} else if (!task?.pendingReply) {
			countdown.textContent = "";
		} else if (task.pendingReply.sendAt !== null && task.status === "pending") {
			const seconds = Math.max(0, Math.ceil((task.pendingReply.sendAt - Date.now()) / 1000));
			countdown.textContent = seconds > 0 ? `Sending in ${seconds}s.` : "Waiting to send...";
		} else {
			countdown.textContent = "Automatic sending is stopped.";
		}
	}

	function render() {
		if (destroyed) return;
		renderConversation();
		const task = state.task;
		const active = Boolean(task && task.status !== "completed" && task.status !== "taken_over");
		const owner = Boolean(task && state.isOwner);
		const currentChat = Boolean(task && state.snapshot?.chatId === task.chatId);
		if ((task?.id ?? null) !== displayedTaskId || (owner && !displayedTaskOwner)) {
			displayedTaskId = task?.id ?? null;
			goalEditorOpen = false;
			renderedAgentChat = null;
			openToolCalls.clear();
			if (task && owner && !goalDirty) goal.value = task.goal;
		}
		displayedTaskOwner = owner;

		goal.disabled = busy || Boolean(active && !owner);
		goalHint.textContent = active
			? "Changes apply after you choose Update instructions."
			: `Replies send automatically after a ${DEFAULT_REPLY_DELAY_SECONDS}-second countdown.`;
		startButton.hidden = active;
		startButton.disabled = busy || !state.snapshot || !goal.value.trim();
		updateGoalButton.hidden = !active;
		updateGoalButton.disabled = busy || !owner || !goal.value.trim() || goal.value.trim() === task?.goal;
		instructions.hidden = Boolean(task) && (!active || !goalEditorOpen);
		goalToggle.hidden = !task || !owner;
		goalToggle.disabled = busy || !active;
		goalToggle.setAttribute("aria-expanded", String(goalEditorOpen));
		goalText.textContent = task?.goal ?? "";
		thread.hidden = !task;
		thread.dataset.status = task?.status ?? "idle";

		taskId.textContent = task ? `Task ID: ${task.id}` : "";
		taskId.hidden = !task;
		taskChat.textContent = task ? `Task chat: ${task.chatId}` : "";
		taskChat.hidden = !task || currentChat;
		taskNotice.textContent = "This task belongs to another conversation. Reopen its dedicated tab to continue.";
		taskNotice.hidden = !task || !state.snapshot || currentChat;
		const chat = owner && task ? task.agentChat : [];
		const baseState = task ? (task.detail ?? `${statusLabels[task.status]}.`) : "";
		const lastAgent = [...chat].reverse().find((message) => message.role === "agent");
		agentState.textContent = baseState + (task && active && !owner ? " (Not connected to this tab.)" : "");
		agentState.hidden = !task || baseState === lastAgent?.text;
		agentState.dataset.status = task?.status ?? "idle";
		agentEmpty.hidden = chat.length !== 0 || !active || !owner;
		const chatKey = JSON.stringify(chat.map(({ id, role, text, body }) => [id, role, text, body]));
		if (chatKey !== renderedAgentChat) {
			renderedAgentChat = chatKey;
			agentMessages.replaceChildren();
			for (const message of chat) {
				const item = document.createElement("li");
				item.dataset.role = message.role;
				if (message.role === "event" && message.body) {
					item.classList.add("tool-call");
					const details = document.createElement("details");
					details.open = openToolCalls.has(message.id);
					details.addEventListener("toggle", () => {
						if (details.open) openToolCalls.add(message.id);
						else openToolCalls.delete(message.id);
					});
					const summary = document.createElement("summary");
					summary.textContent = message.text;
					const body = document.createElement("p");
					body.className = "message-text";
					body.dir = "auto";
					body.textContent = message.body;
					details.append(summary, body);
					item.append(details);
				} else {
					if (message.role !== "event") {
						const sender = document.createElement("strong");
						sender.textContent = message.role === "agent" ? "Envoy" : "You";
						item.append(sender);
					}
					const text = document.createElement("span");
					text.className = "message-text";
					text.dir = "auto";
					text.textContent = message.text;
					item.append(text);
				}
				agentMessages.append(item);
			}
		}
		footer.hidden = !owner || !active;
		answerText.disabled = busy;
		answerSend.disabled = busy || !answerText.value.trim();
		const pending = owner ? (task?.pendingReply ?? null) : null;
		if (task && pending) sendingReply = { taskId: task.id, text: pending.text };
		else if (task?.status !== "sending" || task.id !== sendingReply?.taskId) sendingReply = null;
		const shownText = pending?.text ?? (owner ? sendingReply?.text : undefined) ?? null;
		pendingSection.hidden = shownText === null;
		const pendingKey = pending ? pending.commandId : sendingReply ? `sending:${task?.id}` : null;
		if (chat.length > lastChatCount || (pendingKey && pendingKey !== lastPendingKey)) {
			panel.scrollTop = panel.scrollHeight;
		}
		lastChatCount = chat.length;
		lastPendingKey = pendingKey;
		pendingText.textContent = shownText ?? "";
		const editing = Boolean(task?.status === "editing" && pending && owner);
		editor.hidden = !editing;
		if (editing && pending && editingCommandId !== pending.commandId) {
			editingCommandId = pending.commandId;
			editText.value = pending.text;
		} else if (!editing) {
			editingCommandId = null;
		}

		replyControls.hidden = !owner || !task || !["thinking", "pending", "editing", "sending"].includes(task.status);
		cancelThinking.hidden = !owner || task?.status !== "thinking";
		cancelThinking.disabled = busy;
		sendButton.disabled = busy || !owner || !currentChat || task?.status !== "pending" || !pending;
		editButton.disabled =
			busy || !owner || !currentChat || !(task?.status === "sending" || (task?.status === "pending" && pending));
		cancelButton.disabled =
			busy || !owner || !task || !["thinking", "pending", "editing", "sending"].includes(task.status);
		saveEditButton.disabled = busy || !editing || !editText.value.trim();
		editText.disabled = busy;
		pauseButton.hidden = !owner || !active || task?.status === "paused";
		pauseButton.disabled = busy || task?.status === "paused";
		resumeButton.hidden = !owner || (task?.status !== "paused" && task?.status !== "needs_user");
		resumeButton.disabled = busy || !currentChat || (task?.status !== "paused" && task?.status !== "needs_user");
		const showReconnect = task?.status === "paused" && !owner && currentChat;
		reconnectButton.hidden = !showReconnect;
		reconnectButton.disabled = busy;
		takeoverButton.hidden = !owner || !active;
		takeoverButton.disabled = busy || !active;
		deleteButton.hidden = !task || active;
		deleteButton.disabled = busy;
		header.hidden =
			!task ||
			(goalToggle.hidden && pauseButton.hidden && resumeButton.hidden && takeoverButton.hidden && deleteButton.hidden);
		ownerHint.hidden = !(task && !owner && active);
		ownerHint.textContent = showReconnect
			? "This task is paused. Reconnect to control it from this tab."
			: "This task is controlled by another tab.";
		deleteHint.hidden = deleteButton.hidden;
		deleteHint.textContent =
			"Check the conversation for any unconfirmed send before deleting this task." +
			(owner ? "" : " The original tab must disconnect first.");
		const message = localError ?? state.error;
		error.textContent = message ?? "";
		error.hidden = !message;
		renderCountdown();
	}

	async function run(action: () => Promise<void>) {
		if (busy) return;
		busy = true;
		localError = null;
		render();
		try {
			await action();
		} catch {
			localError = state.error ?? "Could not complete that action. Check the connection and try again.";
		} finally {
			busy = false;
			render();
		}
	}

	function control(action: TaskControlAction, text?: string) {
		void run(() => controller.control(action, text));
	}

	goal.addEventListener("input", () => {
		goalDirty = true;
		render();
	});
	editText.addEventListener("input", render);
	answerText.addEventListener("input", render);
	goalToggle.addEventListener("click", () => {
		if (!state.task || !state.isOwner) return;
		goalEditorOpen = !goalEditorOpen;
		if (goalEditorOpen) {
			goal.value = state.task.goal;
			goalDirty = false;
		}
		render();
		if (goalEditorOpen) goal.focus();
	});
	startButton.addEventListener("click", () => {
		const value = goal.value.trim();
		void run(async () => {
			await controller.start(value);
			goalEditorOpen = false;
			if (goal.value.trim() === value) goalDirty = false;
		});
	});
	updateGoalButton.addEventListener("click", () => {
		const value = goal.value.trim();
		void run(async () => {
			await controller.control("update-goal", value);
			goalEditorOpen = false;
			if (goal.value.trim() === value) goalDirty = false;
		});
	});
	answerSend.addEventListener("click", () => {
		const value = answerText.value.trim();
		void run(async () => {
			await controller.control("answer-agent", value);
			if (answerText.value.trim() === value) answerText.value = "";
		});
	});
	sendButton.addEventListener("click", () => control("send-now"));
	editButton.addEventListener("click", () => control("edit"));
	saveEditButton.addEventListener("click", () => control("save-edit", editText.value.trim()));
	cancelButton.addEventListener("click", () => control("cancel"));
	cancelThinking.addEventListener("click", () => control("cancel"));
	pauseButton.addEventListener("click", () => control("pause"));
	resumeButton.addEventListener("click", () => control("resume"));
	reconnectButton.addEventListener("click", () => void run(() => controller.attach()));
	takeoverButton.addEventListener("click", () => control("take-over"));
	deleteButton.addEventListener("click", () => {
		void run(async () => {
			await controller.clear();
			goal.value = "";
			goalDirty = false;
			goalEditorOpen = false;
			editText.value = "";
		});
	});
	healthButton.addEventListener("click", async () => {
		healthButton.disabled = true;
		healthStatus.textContent = "Checking backend...";
		try {
			healthStatus.textContent = (await controller.checkHealth()) ? "Backend healthy." : "Backend unavailable.";
		} catch {
			healthStatus.textContent = "Backend unavailable.";
		} finally {
			healthButton.disabled = false;
		}
	});

	const unsubscribe = controller.subscribe((next) => {
		state = next;
		render();
	});
	const countdownTimer = window.setInterval(renderCountdown, 1000);
	render();
	void restoreDeveloperMode();
	return {
		host,
		panel,
		selectTab,
		destroy() {
			destroyed = true;
			themeObserver.disconnect();
			unsubscribe();
			window.clearInterval(countdownTimer);
		},
	};
}
