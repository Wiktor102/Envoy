// Browser-neutral contracts only. No Node, Chrome, DOM, or server imports here.
export const DEFAULT_REPLY_DELAY_SECONDS = 10;

export interface HealthResponse {
	status: "ok";
	service: "envoy-backend";
}

export interface ConversationSnapshot {
	chatId: string;
	revision: string;
	messages: readonly { id: string; text: string }[];
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
