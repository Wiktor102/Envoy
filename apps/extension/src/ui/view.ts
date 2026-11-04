import { isTaskEnded, type TaskControlAction } from "@envoy/contracts";
import type { ControllerState, EnvoyController } from "../controller";
import { detectLocale, format, getStrings, observeLocaleChange } from "../i18n";
import { createAgentChat } from "./agent-chat";
import { createConversationPreview } from "./conversation-preview";
import { ENVOY_LOGO_DATA_URI } from "./logo";
import { createSettingsPanel } from "./settings-panel";
import { renderTaskControls } from "./task-controls";
import { isolateTextInput } from "./text-input";
import { queryViewElements } from "./view-elements";
import { applyStaticStrings, countText, detailText, isOverLimit, statusText } from "./view-format";
import styles from "./styles.css?inline";
import markup from "./view.html?raw";

// Markup is static. Conversation and model text are inserted as text, never HTML.
export function createEnvoyView(onSelectionChange: () => void, controller: EnvoyController) {
	const host = document.createElement("envoy-root");
	if (location.hostname === "facebook.com" || location.hostname.endsWith(".facebook.com")) {
		host.setAttribute("data-facebook", "");
	}

	// Facebook marks its active theme on <html>; CSS falls back to the system theme.
	function syncTheme() {
		const classes = document.documentElement.classList;
		if (classes.contains("__fb-dark-mode")) host.setAttribute("data-theme", "dark");
		else if (classes.contains("__fb-light-mode")) host.setAttribute("data-theme", "light");
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
	// Brand mark is inlined so the shadow DOM needs no extension resource URL.
	for (const logo of container.querySelectorAll<HTMLImageElement>("img[data-envoy-logo]")) {
		logo.src = ENVOY_LOGO_DATA_URI;
	}
	shadow.append(style, container);

	let strings = getStrings(detectLocale());
	applyStaticStrings(container, strings);

	const elements = queryViewElements(container);
	const {
		tabs,
		chatsTab,
		envoyTab,
		panel,
		settingsButton,
		goalToggle,
		goalText,
		instructions,
		thread,
		footer,
		goal,
		goalHint,
		startButton,
		updateGoalButton,
		taskId,
		taskChat,
		taskNotice,
		agentState,
		agentEmpty,
		agentMessages,
		answerText,
		answerHint,
		answerSend,
		pendingSection,
		pendingText,
		countdown,
		editor,
		editText,
		delayMin,
		delayMax,
		saveEditButton,
		cancelThinking,
		sendButton,
		editButton,
		cancelButton,
		regenerateButton,
		regenerateWaitingButton,
		pauseButton,
		resumeButton,
		reconnectButton,
		takeoverButton,
		deleteButton,
		error,
		healthButton,
		healthStatus,
	} = elements;
	for (const input of [goal, editText, answerText, delayMin, delayMax]) isolateTextInput(input);

	const conversationPreview = createConversationPreview(elements);
	const agentChat = createAgentChat(agentMessages);
	const settings = createSettingsPanel(host, container, elements, render);

	let state: ControllerState = {
		snapshot: null,
		conversationStatus: strings.openConversation,
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

	function selectTab(showEnvoy: boolean) {
		chatsTab.setAttribute("aria-selected", String(!showEnvoy));
		envoyTab.setAttribute("aria-selected", String(showEnvoy));
		chatsTab.tabIndex = showEnvoy ? -1 : 0;
		envoyTab.tabIndex = showEnvoy ? 0 : -1;
		panel.hidden = !showEnvoy;
		settingsButton.hidden = !showEnvoy;
		if (!showEnvoy) settings.close();
		onSelectionChange();
	}

	chatsTab.addEventListener("click", () => selectTab(false));
	envoyTab.addEventListener("click", () => selectTab(true));
	envoyTab.tabIndex = -1;
	tabs.addEventListener("keydown", (event) => {
		const keyEvent = event as KeyboardEvent;
		if (keyEvent.key !== "ArrowLeft" && keyEvent.key !== "ArrowRight") return;
		keyEvent.preventDefault();
		const showEnvoy = keyEvent.key === "ArrowRight";
		selectTab(showEnvoy);
		(showEnvoy ? envoyTab : chatsTab).focus();
	});

	function setLine(element: HTMLElement, text: string, hide: boolean): void {
		element.textContent = text;
		element.hidden = hide;
	}

	function renderCountdown() {
		const task = state.task;
		if (task?.status === "sending") {
			countdown.textContent = strings.sendingNow;
			return;
		}
		if (!task?.pendingReply) {
			countdown.textContent = "";
			return;
		}
		if (task.pendingReply.sendAt !== null && task.status === "pending") {
			const seconds = Math.max(0, Math.ceil((task.pendingReply.sendAt - Date.now()) / 1000));
			countdown.textContent = seconds > 0 ? format(strings.sendingIn, { seconds }) : strings.waitingToSend;
			return;
		}
		countdown.textContent = settings.autoSend() ? strings.autoSendStopped : strings.waitingSendNow;
	}

	function render() {
		if (destroyed) return;
		conversationPreview.render(state, strings);
		const task = state.task;
		const active = Boolean(task && !isTaskEnded(task.status));
		const owner = Boolean(task && state.isOwner);
		const currentChat = Boolean(task && state.snapshot?.chatId === task.chatId);
		if ((task?.id ?? null) !== displayedTaskId || (owner && !displayedTaskOwner)) {
			displayedTaskId = task?.id ?? null;
			goalEditorOpen = false;
			agentChat.reset();
			if (task && owner && !goalDirty) goal.value = task.goal;
		}
		displayedTaskOwner = owner;

		goal.disabled = busy || Boolean(active && !owner);
		goalHint.textContent = (active ? strings.goalUpdateNote : "") + countText(goal.value, strings);
		goalHint.hidden = false;
		const goalOverLimit = isOverLimit(goal.value);
		settings.render(strings, active);
		startButton.hidden = active;
		startButton.disabled = busy || !state.snapshot || !goal.value.trim() || goalOverLimit;
		updateGoalButton.hidden = !active;
		updateGoalButton.disabled =
			busy || !owner || !goal.value.trim() || goal.value.trim() === task?.goal || goalOverLimit;
		instructions.hidden = Boolean(task) && (!active || !goalEditorOpen);
		goalToggle.hidden = !task || !owner;
		goalToggle.disabled = busy || !active;
		goalToggle.setAttribute("aria-expanded", String(goalEditorOpen));
		goalText.textContent = task?.goal ?? "";
		thread.hidden = !task;
		thread.dataset.status = task?.status ?? "idle";

		setLine(taskId, task ? format(strings.taskIdLine, { id: task.id }) : "", !task);
		setLine(taskChat, task ? format(strings.taskChatLine, { id: task.chatId }) : "", !task || currentChat);
		taskNotice.textContent = strings.taskElsewhere;
		taskNotice.hidden = !task || !state.snapshot || currentChat;
		const chat = owner && task ? task.agentChat : [];
		const baseState = task
			? task.detail
				? detailText(task.detail, strings)
				: `${statusText(task.status, strings)}.`
			: "";
		const lastAgent = [...chat].reverse().find((message) => message.role === "agent");
		agentState.textContent = baseState + (task && active && !owner ? strings.notConnectedNote : "");
		agentState.hidden = !task || baseState === lastAgent?.text;
		agentState.dataset.status = task?.status ?? "idle";
		agentEmpty.hidden = chat.length !== 0 || !active || !owner;
		agentChat.render(chat, strings);
		footer.hidden = !owner || !active;
		answerText.disabled = busy;
		answerHint.textContent = countText(answerText.value, strings);
		answerSend.disabled = busy || !answerText.value.trim() || isOverLimit(answerText.value);
		const pending = owner ? (task?.pendingReply ?? null) : null;
		if (task && pending) sendingReply = { taskId: task.id, text: pending.text };
		else if (task?.status !== "sending" || task.id !== sendingReply?.taskId) sendingReply = null;
		const shownText = pending?.text ?? (owner ? sendingReply?.text : undefined) ?? null;
		pendingSection.hidden = shownText === null;
		const sendingKey = sendingReply ? `sending:${task?.id}` : null;
		const pendingKey = pending?.commandId ?? sendingKey;
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

		renderTaskControls(elements, { task, pending, busy, active, owner, currentChat, editing }, strings);
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
			localError = state.error ?? strings.actionFailedFallback;
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
	function submitInput(
		input: HTMLTextAreaElement,
		submit: (value: string) => Promise<void>,
		after: (value: string) => void,
	) {
		const value = input.value.trim();
		void run(async () => {
			await submit(value);
			after(value);
		});
	}

	function closeGoalEditor(value: string) {
		goalEditorOpen = false;
		if (goal.value.trim() === value) goalDirty = false;
	}

	startButton.addEventListener("click", () => submitInput(goal, (value) => controller.start(value), closeGoalEditor));
	updateGoalButton.addEventListener("click", () =>
		submitInput(goal, (value) => controller.control("update-goal", value), closeGoalEditor),
	);
	answerSend.addEventListener("click", () =>
		submitInput(
			answerText,
			(value) => controller.control("answer-agent", value),
			(value) => {
				if (answerText.value.trim() === value) answerText.value = "";
			},
		),
	);
	// One row per control keeps the duplicate cancel wiring visible.
	const wiredControls: [HTMLButtonElement, TaskControlAction][] = [
		[sendButton, "send-now"],
		[editButton, "edit"],
		[cancelButton, "cancel"],
		[cancelThinking, "cancel"],
		[regenerateButton, "regenerate"],
		[regenerateWaitingButton, "regenerate"],
		[pauseButton, "pause"],
		[resumeButton, "resume"],
		[takeoverButton, "take-over"],
	];
	for (const [button, action] of wiredControls) button.addEventListener("click", () => control(action));
	saveEditButton.addEventListener("click", () => control("save-edit", editText.value.trim()));
	reconnectButton.addEventListener("click", () => void run(() => controller.attach()));
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
		healthStatus.textContent = strings.checkingBackend;
		try {
			healthStatus.textContent = (await controller.checkHealth())
				? strings.backendHealthy
				: strings.backendUnavailable;
		} catch {
			healthStatus.textContent = strings.backendUnavailable;
		} finally {
			healthButton.disabled = false;
		}
	});

	const unsubscribe = controller.subscribe((next) => {
		state = next;
		render();
	});
	// Controller and conversation statuses keep the language they arrived in
	// until their next update; everything rendered here switches right away.
	const stopLocale = observeLocaleChange((next) => {
		strings = getStrings(next);
		conversationPreview.invalidate();
		agentChat.invalidate();
		applyStaticStrings(container, strings);
		render();
	});
	const countdownTimer = window.setInterval(renderCountdown, 1000);
	settings.start();
	return {
		host,
		panel,
		selectTab,
		destroy() {
			destroyed = true;
			settings.destroy();
			themeObserver.disconnect();
			stopLocale();
			unsubscribe();
			window.clearInterval(countdownTimer);
		},
	};
}
