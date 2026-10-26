// Browser-neutral contracts only. No Node, Chrome, DOM, or server imports here.
export const DEFAULT_REPLY_DELAY_SECONDS = 10;

export interface HealthResponse {
	status: "ok";
	service: "envoy-backend";
}

export interface ImageAttachment {
	type: "image";
	url: string | null;
	description: string | null;
}

export interface ConversationMessage {
	// Temporary identifier for a rendered node; it can change on reload or remount.
	id: string;
	text: string;
	// The quoted text is a preview, not a stable reference to another message.
	replyTo: { text: string | null; context: string | null; attachments: readonly ImageAttachment[] } | null;
	attachments: readonly ImageAttachment[];
	reactions: readonly { label: string; emojis: readonly string[]; count: number | null }[];
}

export interface ConversationSnapshot {
	chatId: string;
	// Digest of the currently rendered conversation, not proof of complete history.
	revision: string;
	messages: readonly ConversationMessage[];
}

export interface SendReplyCommand {
	commandId: string;
	chatId: string;
	expectedRevision: string;
	text: string;
}

export interface TaskState {
	id: string;
	chatId: string;
	goal: string;
	pendingReply: SendReplyCommand | null;
}

export interface HealthRequest {
	type: "envoy:health";
}

export type HealthReply = { ok: true; health: HealthResponse } | { ok: false; error: "backend-unavailable" };
