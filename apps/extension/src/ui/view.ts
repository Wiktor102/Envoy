import { DEFAULT_REPLY_DELAY_SECONDS, type TaskControlAction, type TaskStatus } from "@envoy/contracts";
import type { ControllerState, EnvoyController } from "../controller";
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
	const chatId = element<HTMLElement>("#envoy-chat-id");
	const conversationStatus = element<HTMLElement>("#envoy-conversation-status");
	const conversation = element<HTMLOListElement>("#envoy-conversation");
	const goal = element<HTMLTextAreaElement>("#envoy-goal");
	const goalHint = element<HTMLElement>("#envoy-goal-hint");
	const startButton = element<HTMLButtonElement>("#envoy-start");
	const updateGoalButton = element<HTMLButtonElement>("#envoy-update-goal");
	const taskStatus = element<HTMLElement>("#envoy-task-status");
	const taskChat = element<HTMLElement>("#envoy-task-chat");
	const taskDetail = element<HTMLElement>("#envoy-task-detail");
	const pendingSection = element<HTMLElement>("#envoy-pending");
	const pendingText = element<HTMLElement>("#envoy-pending-text");
	const countdown = element<HTMLElement>("#envoy-countdown");
	const editor = element<HTMLElement>("#envoy-editor");
	const editText = element<HTMLTextAreaElement>("#envoy-reply-edit");
	const saveEditButton = element<HTMLButtonElement>("#envoy-save-edit");
	const sendButton = element<HTMLButtonElement>("#envoy-send-now");
	const editButton = element<HTMLButtonElement>("#envoy-edit");
	const cancelButton = element<HTMLButtonElement>("#envoy-cancel");
	const pauseButton = element<HTMLButtonElement>("#envoy-pause");
	const resumeButton = element<HTMLButtonElement>("#envoy-resume");
	const reconnectButton = element<HTMLButtonElement>("#envoy-reconnect");
	const takeoverButton = element<HTMLButtonElement>("#envoy-take-over");
	const deleteButton = element<HTMLButtonElement>("#envoy-delete");
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
	let editingCommandId: string | null = null;
	let renderedConversation: string | null = null;

	function selectTab(showEnvoy: boolean) {
		chatsTab.setAttribute("aria-selected", String(!showEnvoy));
		envoyTab.setAttribute("aria-selected", String(showEnvoy));
		chatsTab.tabIndex = showEnvoy ? -1 : 0;
		envoyTab.tabIndex = showEnvoy ? 0 : -1;
		panel.hidden = !showEnvoy;
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
		const key = snapshot ? JSON.stringify([snapshot.chatId, snapshot.revision]) : null;
		if (key === renderedConversation) return;
		renderedConversation = key;
		conversation.replaceChildren();
		if (!snapshot) return;

		for (const message of snapshot.messages.slice(-5)) {
			const item = document.createElement("li");
			const sender = document.createElement("strong");
			sender.textContent =
				message.direction === "outgoing"
					? "You"
					: message.direction === "incoming"
						? "Other person"
						: "Unknown sender";
			const text = document.createElement("span");
			text.className = "message-text";
			text.textContent = message.text || (message.attachments.length ? "[Attachment]" : "[Empty message]");
			item.append(sender, text);
			conversation.append(item);
		}
	}

	function renderCountdown() {
		const task = state.task;
		if (!task?.pendingReply) {
			countdown.textContent = "";
			return;
		}
		if (task.status === "sending") {
			countdown.textContent = "Sending...";
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

		taskStatus.textContent = task
			? `${statusLabels[task.status]}${active && !owner ? " (not connected to this tab)" : ""}.`
			: "No active task.";
		taskChat.textContent = task ? `Task chat: ${task.chatId}` : "";
		taskChat.hidden = !task || currentChat;
		taskDetail.textContent = owner ? (task?.detail ?? "") : "";
		taskDetail.hidden = !owner || !task?.detail;
		const pending = owner ? (task?.pendingReply ?? null) : null;
		pendingSection.hidden = !pending;
		pendingText.textContent = pending?.text ?? "";
		const editing = Boolean(task?.status === "editing" && pending && owner);
		editor.hidden = !editing;
		if (editing && pending && editingCommandId !== pending.commandId) {
			editingCommandId = pending.commandId;
			editText.value = pending.text;
		} else if (!editing) {
			editingCommandId = null;
		}

		sendButton.disabled = busy || !owner || !currentChat || task?.status !== "pending" || !pending;
		editButton.disabled =
			busy || !owner || !currentChat || !(task?.status === "sending" || (task?.status === "pending" && pending));
		cancelButton.disabled =
			busy || !owner || !task || !["thinking", "pending", "editing", "sending"].includes(task.status);
		saveEditButton.disabled = busy || !editing || !editText.value.trim();
		editText.disabled = busy;
		pauseButton.disabled = busy || !owner || !active || task?.status === "paused";
		resumeButton.disabled =
			busy || !owner || !currentChat || (task?.status !== "paused" && task?.status !== "needs_user");
		reconnectButton.hidden = !(task?.status === "paused" && !owner && currentChat);
		reconnectButton.disabled = busy;
		takeoverButton.disabled = busy || !owner || !active;
		deleteButton.hidden = !task || active;
		deleteButton.disabled = busy;
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
	startButton.addEventListener("click", () => {
		const value = goal.value.trim();
		void run(async () => {
			await controller.start(value);
			if (goal.value.trim() === value) goalDirty = false;
		});
	});
	updateGoalButton.addEventListener("click", () => {
		const value = goal.value.trim();
		void run(async () => {
			await controller.control("update-goal", value);
			if (goal.value.trim() === value) goalDirty = false;
		});
	});
	sendButton.addEventListener("click", () => control("send-now"));
	editButton.addEventListener("click", () => control("edit"));
	saveEditButton.addEventListener("click", () => control("save-edit", editText.value.trim()));
	cancelButton.addEventListener("click", () => control("cancel"));
	pauseButton.addEventListener("click", () => control("pause"));
	resumeButton.addEventListener("click", () => control("resume"));
	reconnectButton.addEventListener("click", () => void run(() => controller.attach()));
	takeoverButton.addEventListener("click", () => control("take-over"));
	deleteButton.addEventListener("click", () => {
		void run(async () => {
			await controller.clear();
			goal.value = "";
			goalDirty = false;
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
	return {
		host,
		panel,
		selectTab,
		destroy() {
			destroyed = true;
			unsubscribe();
			window.clearInterval(countdownTimer);
		},
	};
}
