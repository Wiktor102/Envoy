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

export type MessageAttachment = ImageAttachment | VideoAttachment | StickerAttachment;

export interface ConversationMessage {
	// Temporary identifier for a rendered node; it can change on reload or remount.
	id: string;
	text: string;
	// Unknown must never be treated as an incoming message.
	direction: "incoming" | "outgoing" | "unknown" | "system";
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
