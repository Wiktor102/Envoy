// Browser-neutral contracts only. No Node, Chrome, DOM, or server imports here.
export const DEFAULT_REPLY_DELAY_SECONDS = 10;
export const MIN_REPLY_DELAY_SECONDS = 1;
export const MAX_REPLY_DELAY_SECONDS = 600;

// Browser-local preference. Each automatic send waits a random whole number of
// seconds in [minDelaySeconds, maxDelaySeconds]; without autoSend a proposed
// reply waits for Send now.
export interface ReplySettings {
	autoSend: boolean;
	minDelaySeconds: number;
	maxDelaySeconds: number;
}

export const DEFAULT_REPLY_SETTINGS: Readonly<ReplySettings> = {
	autoSend: true,
	minDelaySeconds: DEFAULT_REPLY_DELAY_SECONDS,
	maxDelaySeconds: DEFAULT_REPLY_DELAY_SECONDS,
};

function delaySeconds(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(MAX_REPLY_DELAY_SECONDS, Math.max(MIN_REPLY_DELAY_SECONDS, Math.round(value)));
}

// Stored values may be missing or come from an older version; fall back to
// defaults field by field instead of rejecting the whole preference.
export function normalizeReplySettings(value: unknown): ReplySettings {
	const item = value && typeof value === "object" ? (value as Partial<Record<keyof ReplySettings, unknown>>) : {};
	const minDelaySeconds = delaySeconds(item.minDelaySeconds, DEFAULT_REPLY_SETTINGS.minDelaySeconds);
	return {
		autoSend: typeof item.autoSend === "boolean" ? item.autoSend : DEFAULT_REPLY_SETTINGS.autoSend,
		minDelaySeconds,
		maxDelaySeconds: Math.max(
			minDelaySeconds,
			delaySeconds(item.maxDelaySeconds, DEFAULT_REPLY_SETTINGS.maxDelaySeconds),
		),
	};
}

export interface HealthResponse {
	status: "ok";
	service: "envoy-backend";
}

// Photos, video stills, GIFs, and stickers reach the model as image blocks.
// Files stay presence-only: the reader captures them so they pause instead of
// failing the whole snapshot.
export const MAX_IMAGE_SIDE = 1568;
// One shared cap across every forwardable media type, newest first.
export const MAX_SNAPSHOT_IMAGES = 4;
// Base64 characters per inline image and per snapshot. Both stay well under
// the backend socket payload limit.
export const MAX_INLINE_MEDIA_CHARS = 1_000_000;
export const MAX_SNAPSHOT_MEDIA_CHARS = 3_000_000;

export const INLINE_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type InlineImageMime = (typeof INLINE_IMAGE_MIMES)[number];

export interface InlineImageMedia {
	mime: InlineImageMime;
	// Base64 bytes, already downscaled to MAX_IMAGE_SIDE by the sender.
	data: string;
	width: number;
	height: number;
}

export interface ImageAttachment {
	type: "image";
	url: string | null;
	description: string | null;
	// Inline bytes for local sources the backend cannot fetch. Null for remote
	// sources and when extraction failed. Older clients omit this field.
	media: InlineImageMedia | null;
}

export interface VideoAttachment {
	type: "video";
	url: string | null;
	description: null;
	// Poster frame for local sources the backend cannot fetch. Null for remote
	// sources (the backend attempts the clip URL as a video block instead)
	// and when extraction failed. Older clients omit this field.
	media: InlineImageMedia | null;
}

export interface StickerAttachment {
	type: "sticker";
	url: string | null;
	description: null;
	// Inline bytes for local sources the backend cannot fetch. Null for remote
	// sources and when extraction failed. Older clients omit this field.
	media: InlineImageMedia | null;
}

export interface GifAttachment {
	type: "gif";
	url: string | null;
	description: null;
	// Inline bytes for local sources the backend cannot fetch. Null for remote
	// sources and when extraction failed. Older clients omit this field.
	media: InlineImageMedia | null;
}

// Presence-only. A file's bytes never reach the model; capturing the row
// keeps the reader fail-closed without failing the whole snapshot.
export interface FileAttachment {
	type: "file";
}

export type MessageAttachment = ImageAttachment | VideoAttachment | StickerAttachment | GifAttachment | FileAttachment;

export interface ConversationMessage {
	// Temporary identifier for a rendered node; it can change on reload or remount.
	id: string;
	// Stable matching key from the message boundary's data-message-id, within
	// one account's view. Null when absent. Never part of the revision:
	// identity, not content.
	stableId: string | null;
	// Messenger's edited marker for plain text messages. True when the marker
	// is present, false when confidently absent, null when unknown (including
	// captions, attachments, and unrecognized heading buttons). Older clients
	// omit this field; treat a missing value as unknown.
	edited: boolean | null;
	text: string;
	// Unknown must never be treated as an incoming message.
	direction: "incoming" | "outgoing" | "unknown" | "system";
	// Unverified viewer-relative display label from the message boundary, kept
	// as parsed. Attribution-only metadata: excluded from the revision like
	// participants, never a verified identity, and PII like message bodies.
	// Null when the label is missing, malformed, or attribution-ambiguous.
	sender: string | null;
	// The quoted text is a preview, not a stable reference to another message.
	replyTo: { text: string | null; context: string | null; attachments: readonly MessageAttachment[] } | null;
	attachments: readonly MessageAttachment[];
	reactions: readonly { label: string; emojis: readonly string[]; count: number | null }[];
	// The sender withdrew this message. Its placeholder is not message text.
	unsent: boolean;
}

export interface ConversationSnapshot {
	chatId: string;
	// Digest of the currently rendered conversation, not proof of complete history.
	revision: string;
	messages: readonly ConversationMessage[];
	// Unverified chat-header display strings, shown as-is. Empty when the header
	// is missing or ambiguous. Zero or one entries for now, leaving room for
	// groups. Attribution-only metadata: never part of the revision, never a
	// verified identity, and names are PII like message bodies.
	participants: readonly string[];
}

// Upper bound for a reply, the user's instructions, or an answer to the agent.
export const MAX_TASK_TEXT_LENGTH = 4000;

// Replies must be a single line without control characters.
export function hasControlCharacters(text: string): boolean {
	return /[\u0000-\u001f\u007f\u2028\u2029]/u.test(text);
}

export interface SendReplyCommand {
	commandId: string;
	chatId: string;
	expectedRevision: string;
	text: string;
}

export interface PendingReply extends SendReplyCommand {
	// Null while the owner is editing. Editing never restarts the countdown.
	sendAt: number | null;
}

export type TaskStatus =
	"thinking" | "waiting" | "pending" | "editing" | "sending" | "paused" | "needs_user" | "completed" | "taken_over";

export function isTaskEnded(status: TaskStatus): boolean {
	return status === "completed" || status === "taken_over";
}

export type AgentChatRole = "agent" | "user" | "event";

export interface AgentChatMessage {
	// Backend-owned identifier. Unlike Messenger node IDs, it survives reloads.
	id: string;
	role: AgentChatRole;
	text: string;
	// Expandable detail, such as the text of a sent reply. Null when the line stands alone.
	body: string | null;
	createdAt: number;
}

export type TaskDetailCode =
	| "previous_send_may_have_completed"
	| "reconnected_send_may_have_completed"
	| "reconnected_resume_ready"
	| "send_may_have_completed_before_editing"
	| "countdown_stopped_while_editing"
	| "edited_reply_saved"
	| "sending_when_tab_checks_in"
	| "send_may_have_completed_before_resuming"
	| "reply_cancelled_waiting"
	| "paused_send_may_have_completed"
	| "paused_checking_previous_send"
	| "paused_by_you"
	| "taken_over_send_may_have_completed"
	| "taken_over_checking_previous_send"
	| "taken_over_in_control"
	| "checking_previous_send_before_sending"
	| "checking_conversation_before_sending"
	| "reply_not_sent_retry"
	| "reply_sent_waiting"
	| "reply_not_sent_check_conversation"
	| "send_unconfirmed_check_conversation"
	| "auto_send_off"
	| "previous_send_may_have_completed_before_new_task"
	| "paused_previous_send_may_have_completed"
	| "previous_send_may_have_completed_before_resuming"
	| "checking_previous_send"
	| "latest_unsent_check_conversation"
	| "waiting_for_incoming"
	| "latest_unknown_sender"
	| "latest_unreadable"
	| "latest_quotes_image"
	| "latest_quotes_media"
	| "considering_conversation"
	| "checking_if_task_complete"
	| "model_no_decision"
	| "model_key_missing"
	| "model_invalid_reply"
	| "review_reply_before_send"
	| "waiting_for_message"
	| "tab_changed_conversations"
	| "conversation_unavailable_resumable"
	| "conversation_unavailable"
	| "conversation_unverifiable"
	| "reply_unverifiable"
	| "tab_disconnected"
	| "tab_stopped_checking_in"
	| "tab_changed_conversations_send_uncertain"
	| "conversation_unavailable_resumable_send_uncertain"
	| "conversation_unavailable_send_uncertain"
	| "conversation_unverifiable_send_uncertain"
	| "reply_unverifiable_send_uncertain"
	| "tab_disconnected_send_uncertain"
	| "tab_stopped_checking_in_send_uncertain";

// Fixed backend statuses are codes the UI localizes; only ask/finish carry
// model-written text.
export type TaskDetail = { code: TaskDetailCode } | { code: "agent_message"; text: string };

export interface TaskState {
	id: string;
	chatId: string;
	goal: string;
	status: TaskStatus;
	pendingReply: PendingReply | null;
	// A short status or question for the user. Never an API error containing message bodies.
	detail: TaskDetail | null;
	// Private conversation with Envoy: agent questions, user answers, and reply
	// outcomes. Task-local history; it dies with the task.
	agentChat: AgentChatMessage[];
}

export type AgentDecision =
	| { action: "reply"; text: string }
	| { action: "wait" }
	| { action: "ask"; text: string }
	| { action: "finish"; text: string };

export interface ConnectorSync {
	connectorId: string;
	snapshot: ConversationSnapshot | null;
}

export interface ConnectorSyncResult {
	task: TaskState | null;
	isOwner: boolean;
	command: SendReplyCommand | null;
}

export type SendResult = "sent" | "rejected" | "uncertain";

export type TaskControlAction =
	"send-now" | "edit" | "save-edit" | "cancel" | "pause" | "resume" | "take-over" | "update-goal" | "answer-agent";

export interface HealthRequest {
	type: "envoy:health";
}

export type HealthReply = { ok: true; health: HealthResponse } | { ok: false; error: "backend-unavailable" };

// Transport bytes never identify content. The rendered source already feeds
// the revision through the fingerprint; hashing base64 would only churn.
// Sticker URLs rotate across reloads and may be sensitive, so the graphic
// label in the DOM fingerprint identifies the sticker instead.
export function attachmentIdentity(attachment: MessageAttachment): MessageAttachment {
	switch (attachment.type) {
		case "image":
		case "video":
		case "gif":
			return attachment.media ? { ...attachment, media: null } : attachment;
		case "sticker":
			return { ...attachment, url: null, media: null };
		case "file":
			return attachment;
	}
}

// The content a revision covers. Node IDs and stable IDs are identity,
// sender labels are attribution-only, and inline bytes are transport. The
// edited marker is observable content state: a flag change invalidates.
export function messageContent({ text, direction, replyTo, attachments, reactions, unsent, edited }: ConversationMessage) {
	return {
		text,
		direction,
		replyTo,
		attachments: attachments.map(attachmentIdentity),
		reactions,
		unsent,
		edited: edited ?? null,
	};
}

function fetchableMediaUrl(url: string | null): boolean {
	// Prefix only; the backend parses strictly before fetching. A malformed
	// URL merely fails there and stays presence-only.
	return !!url && url.startsWith("https://");
}

function forwardableAttachment(attachment: MessageAttachment): boolean {
	switch (attachment.type) {
		case "image":
		case "gif":
		case "sticker":
			return fetchableMediaUrl(attachment.url) || !!attachment.media;
		case "video":
			// A captured poster frame forwards as a still; otherwise the
			// backend attempts the clip URL as a video block, falling back
			// to presence-only if the endpoint rejects it.
			return fetchableMediaUrl(attachment.url) || !!attachment.media;
		case "file":
			return false;
	}
}

// Newest-first selection of the media the model may see, one flag per
// attachment in message order. Reply quotes never qualify: their bytes stay
// client-side. Anything beyond MAX_SNAPSHOT_IMAGES stays presence-only.
export function forwardableMediaSlots(messages: readonly ConversationMessage[]): boolean[][] {
	const slots = messages.map((message) => message.attachments.map(() => false));
	let remaining = MAX_SNAPSHOT_IMAGES;
	for (let m = messages.length - 1; m >= 0 && remaining > 0; m--) {
		const attachments = messages[m]!.attachments;
		for (let a = attachments.length - 1; a >= 0 && remaining > 0; a--) {
			if (!forwardableAttachment(attachments[a]!)) continue;
			slots[m]![a] = true;
			remaining--;
		}
	}
	return slots;
}

// Historical name for the shared media selection above.
export function forwardableImageSlots(messages: readonly ConversationMessage[]): boolean[][] {
	return forwardableMediaSlots(messages);
}
