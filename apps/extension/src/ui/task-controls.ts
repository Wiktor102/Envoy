import type { PendingReply, TaskState } from "@envoy/contracts";
import type { ExtensionStrings } from "../i18n";
import { countText, isOverLimit } from "./view-format";
import type { ViewElements } from "./view-elements";

// Interruptible states share one list so the reply and cancel controls
// cannot drift apart when a status is added.
const REPLY_ACTIVE_STATUSES = ["thinking", "pending", "editing", "sending"];

interface TaskControlsState {
	task: TaskState | null;
	pending: PendingReply | null;
	busy: boolean;
	active: boolean;
	owner: boolean;
	currentChat: boolean;
	editing: boolean;
}

// Which task and reply actions are visible and enabled.
export function renderTaskControls(
	{
		goalToggle,
		header,
		editText,
		editHint,
		saveEditButton,
		replyControls,
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
		ownerHint,
		deleteHint,
	}: ViewElements,
	{ task, pending, busy, active, owner, currentChat, editing }: TaskControlsState,
	strings: ExtensionStrings,
) {
	const canCancelReply = owner && !!task && REPLY_ACTIVE_STATUSES.includes(task.status);
	const canSendReply = owner && currentChat && task?.status === "pending" && !!pending;
	const canEditReply = canSendReply || (owner && currentChat && task?.status === "sending");
	replyControls.hidden = !canCancelReply;
	cancelThinking.hidden = !owner || task?.status !== "thinking";
	cancelThinking.disabled = busy;
	sendButton.disabled = busy || !canSendReply;
	editButton.disabled = busy || !canEditReply;
	cancelButton.disabled = busy || !canCancelReply;
	const canRegenerateDraft =
		owner && currentChat && !!pending && (task?.status === "pending" || task?.status === "editing");
	regenerateButton.hidden = !canRegenerateDraft;
	regenerateButton.disabled = busy || !canRegenerateDraft;
	const canRegenerateWaiting =
		owner && currentChat && task?.status === "waiting" && (task.detail?.code ?? null) === "reply_cancelled_waiting";
	regenerateWaitingButton.hidden = !canRegenerateWaiting;
	regenerateWaitingButton.disabled = busy || !canRegenerateWaiting;
	editHint.textContent = `${strings.saveEditNote} ${countText(editText.value, strings)}`;
	saveEditButton.disabled = busy || !editing || !editText.value.trim() || isOverLimit(editText.value);
	editText.disabled = busy;
	const isPaused = task?.status === "paused";
	const isResumable = task?.status === "paused" || task?.status === "needs_user";
	pauseButton.hidden = !owner || !active || isPaused;
	pauseButton.disabled = busy || isPaused;
	resumeButton.hidden = !owner || !isResumable;
	resumeButton.disabled = busy || !currentChat || !isResumable;
	const showReconnect = task?.status === "paused" && !owner && currentChat;
	reconnectButton.hidden = !showReconnect;
	reconnectButton.disabled = busy;
	takeoverButton.hidden = !owner || !active;
	takeoverButton.disabled = busy || !active;
	deleteButton.hidden = !task || active;
	deleteButton.disabled = busy;
	const taskControls = [goalToggle, pauseButton, resumeButton, takeoverButton, deleteButton];
	header.hidden = !task || taskControls.every((button) => button.hidden);
	ownerHint.hidden = !(task && !owner && active);
	ownerHint.textContent = showReconnect ? strings.ownerPaused : strings.ownerElsewhere;
	deleteHint.hidden = deleteButton.hidden;
	deleteHint.textContent = strings.deleteCheck + (owner ? "" : strings.deleteDisconnect);
}
