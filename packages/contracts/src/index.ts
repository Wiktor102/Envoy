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

// Photos only. Video, GIF, stickers, and files stay presence-only.
export const MAX_IMAGE_SIDE = 1568;
export const MAX_SNAPSHOT_IMAGES = 4;
// Base64 characters per inline image and per snapshot. Both stay well under
// the backend socket payload limit.
export const MAX_INLINE_MEDIA_CHARS = 1_000_000;
export const MAX_SNAPSHOT_MEDIA_CHARS = 3_000_000;

export type InlineImageMime = "image/jpeg" | "image/png" | "image/webp";

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
	url: null;
	description: null;
}

export interface StickerAttachment {
	type: "sticker";
	url: null;
	description: null;
}

export interface GifAttachment {
	type: "gif";
	url: null;
	description: null;
}

export type MessageAttachment = ImageAttachment | VideoAttachment | StickerAttachment | GifAttachment;

export interface ConversationMessage {
	// Temporary identifier for a rendered node; it can change on reload or remount.
	id: string;
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

export interface TaskState {
	id: string;
	chatId: string;
	goal: string;
	status: TaskStatus;
	pendingReply: PendingReply | null;
	// A short status or question for the user. Never an API error containing message bodies.
	detail: string | null;
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
export function attachmentIdentity(attachment: MessageAttachment): MessageAttachment {
	return attachment.type === "image" && attachment.media ? { ...attachment, media: null } : attachment;
}

function fetchableImageUrl(url: string | null): boolean {
	// Prefix only; the backend parses strictly before fetching. A malformed
	// URL merely fails there and stays presence-only.
	return !!url && url.startsWith("https://");
}

// Newest-first selection of the images the model may see, one flag per
// attachment in message order. Reply quotes never qualify: their bytes stay
// client-side. Anything beyond MAX_SNAPSHOT_IMAGES stays presence-only.
export function forwardableImageSlots(messages: readonly ConversationMessage[]): boolean[][] {
	const slots = messages.map((message) => message.attachments.map(() => false));
	let remaining = MAX_SNAPSHOT_IMAGES;
	for (let m = messages.length - 1; m >= 0 && remaining > 0; m--) {
		const attachments = messages[m]!.attachments;
		for (let a = attachments.length - 1; a >= 0 && remaining > 0; a--) {
			const attachment = attachments[a]!;
			if (attachment.type !== "image") continue;
			if (!fetchableImageUrl(attachment.url) && !attachment.media) continue;
			slots[m]![a] = true;
			remaining--;
		}
	}
	return slots;
}
