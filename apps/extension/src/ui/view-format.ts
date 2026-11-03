import {
	MAX_TASK_TEXT_LENGTH,
	type ConversationMessage,
	type ReplySettings,
	type TaskDetail,
	type TaskStatus,
} from "@envoy/contracts";
import { format, type ExtensionStrings } from "../i18n";

type StringKeys = {
	[K in keyof ExtensionStrings]: ExtensionStrings[K] extends string ? K : never;
}[keyof ExtensionStrings];

const statusKeys: Record<TaskStatus, StringKeys> = {
	thinking: "statusThinking",
	waiting: "statusWaiting",
	pending: "statusPending",
	editing: "statusEditing",
	sending: "statusSending",
	paused: "statusPaused",
	needs_user: "statusNeedsUser",
	completed: "statusCompleted",
	taken_over: "statusTakenOver",
};

export function statusText(status: TaskStatus, strings: ExtensionStrings): string {
	return strings[statusKeys[status]];
}

export function detailText(detail: TaskDetail, strings: ExtensionStrings): string {
	return detail.code === "agent_message" ? detail.text : strings.details[detail.code];
}

// Static labels live in the markup under data-i18n attributes; dynamic
// text is set from the same table during render.
export function applyStaticStrings(container: HTMLElement, strings: ExtensionStrings) {
	function localized(key: string | undefined): string | null {
		if (!key || !(key in strings)) return null;
		const value = strings[key as keyof ExtensionStrings];
		return typeof value === "string" ? value : null;
	}

	for (const target of container.querySelectorAll<HTMLElement>("[data-i18n]")) {
		const text = localized(target.dataset.i18n);
		if (text !== null) target.textContent = text;
	}
	const attributes = [
		["i18nAriaLabel", "aria-label"],
		["i18nTitle", "title"],
		["i18nPlaceholder", "placeholder"],
	] as const;
	for (const target of container.querySelectorAll<HTMLElement>(
		"[data-i18n-aria-label], [data-i18n-title], [data-i18n-placeholder]",
	)) {
		for (const [datasetKey, attribute] of attributes) {
			const text = localized(target.dataset[datasetKey]);
			if (text !== null) target.setAttribute(attribute, text);
		}
	}
}

export function senderLabel(
	direction: string,
	sender: string | null,
	incomingLabel: string,
	strings: ExtensionStrings,
): string {
	switch (direction) {
		case "outgoing":
			return strings.you;
		case "incoming":
			return sender ?? incomingLabel;
		case "system":
			return strings.systemName;
		default:
			return strings.unknownSender;
	}
}

export function makeSender(label: string): HTMLElement {
	const sender = document.createElement("strong");
	sender.textContent = label;
	return sender;
}

export function makeText(): HTMLSpanElement {
	const text = document.createElement("span");
	text.className = "message-text";
	text.dir = "auto";
	return text;
}

export function isOverLimit(value: string): boolean {
	return value.trim().length > MAX_TASK_TEXT_LENGTH;
}

export function replyDelayHint(
	{ autoSend, minDelaySeconds, maxDelaySeconds }: ReplySettings,
	strings: ExtensionStrings,
): string {
	if (!autoSend) return strings.delayManual;
	if (minDelaySeconds === maxDelaySeconds) return format(strings.delayFixed, { min: minDelaySeconds });
	return format(strings.delayRandom, { min: minDelaySeconds, max: maxDelaySeconds });
}

export function messagePreview(message: ConversationMessage, strings: ExtensionStrings): string {
	if (message.unsent) return strings.unsentPlaceholder;
	if (message.text) return message.text;
	return message.attachments.length ? strings.attachmentPlaceholder : strings.emptyPlaceholder;
}

// Each limited input has its own bound. The backend trims before checking,
// so the count matches the text that would actually be sent.
export function countText(value: string, strings: ExtensionStrings): string {
	const length = value.trim().length;
	return (
		`${length} / ${MAX_TASK_TEXT_LENGTH} ${strings.charsUnit}` + (length > MAX_TASK_TEXT_LENGTH ? strings.tooLong : "")
	);
}
