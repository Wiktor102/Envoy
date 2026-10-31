import { initTRPC, TRPCError } from "@trpc/server";
import type {
	ConversationMessage,
	ConversationSnapshot,
	HealthResponse,
	InlineImageMedia,
	InlineImageMime,
	MessageAttachment,
	ReplySettings,
	SendResult,
	TaskControlAction,
} from "@envoy/contracts";
import {
	MAX_IMAGE_SIDE,
	MAX_INLINE_MEDIA_CHARS,
	MAX_REPLY_DELAY_SECONDS,
	MAX_SNAPSHOT_IMAGES,
	MAX_SNAPSHOT_MEDIA_CHARS,
	MIN_REPLY_DELAY_SECONDS,
} from "@envoy/contracts";
import { MetaModelAdapter } from "./agent/meta-model.js";
import { TaskService } from "./tasks/service.js";

const t = initTRPC.create();
const service = new TaskService(new MetaModelAdapter());

// Each parser returns a fresh, bounded value. Conversation text is never put in
// validation errors, and no procedure accepts an unchecked client object.
function invalid(): never {
	throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid request." });
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	return value as Record<string, unknown>;
}

function string(value: unknown, max = 512, allowEmpty = false): string {
	if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) return invalid();
	return value;
}

function optionalText(value: unknown, max: number): string | null {
	return value === null ? null : string(value, max, true);
}

function array(value: unknown, max: number): unknown[] {
	if (!Array.isArray(value) || value.length > max) return invalid();
	return value;
}

const inlineMimes: readonly InlineImageMime[] = ["image/jpeg", "image/png", "image/webp"];

function inlineMedia(value: unknown): InlineImageMedia {
	const item = object(value);
	if (typeof item.mime !== "string" || !inlineMimes.includes(item.mime as InlineImageMime)) return invalid();
	if (
		typeof item.data !== "string" ||
		!item.data.length ||
		item.data.length > MAX_INLINE_MEDIA_CHARS ||
		item.data.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)
	)
		return invalid();
	for (const side of [item.width, item.height]) {
		if (!Number.isSafeInteger(side) || (side as number) < 1 || (side as number) > MAX_IMAGE_SIDE) return invalid();
	}
	return {
		mime: item.mime as InlineImageMime,
		data: item.data,
		width: item.width as number,
		height: item.height as number,
	};
}

function attachment(value: unknown, allowMedia: boolean): MessageAttachment {
	const item = object(value);
	if (item.type === "video" || item.type === "sticker" || item.type === "gif") {
		if (item.url !== null || item.description !== null) return invalid();
		return { type: item.type, url: null, description: null };
	}
	if (item.type !== "image") return invalid();
	// Reply quotes stay type-only: their bytes never reach the backend.
	const media = item.media === undefined || item.media === null ? null : allowMedia ? inlineMedia(item.media) : invalid();
	return {
		type: "image",
		url: optionalText(item.url, 8192),
		description: optionalText(item.description, 4000),
		media,
	};
}

function message(value: unknown): ConversationMessage {
	const item = object(value);
	const direction = item.direction;
	if (direction !== "incoming" && direction !== "outgoing" && direction !== "unknown" && direction !== "system")
		return invalid();
	if (typeof item.unsent !== "boolean") return invalid();
	const reply = item.replyTo === null ? null : object(item.replyTo);
	return {
		id: string(item.id),
		text: string(item.text, 20_000, true),
		direction,
		// Per-message display label. Older extension versions send no field.
		sender: item.sender === undefined ? null : optionalText(item.sender, 512),
		replyTo: reply && {
			text: optionalText(reply.text, 20_000),
			context: optionalText(reply.context, 4000),
			attachments: array(reply.attachments, 50).map((value) => attachment(value, false)),
		},
		attachments: array(item.attachments, 50).map((value) => attachment(value, true)),
		reactions: array(item.reactions, 100).map((value) => {
			const reaction = object(value);
			if (reaction.count !== null && (!Number.isSafeInteger(reaction.count) || (reaction.count as number) < 0))
				return invalid();
			return {
				label: string(reaction.label, 4000, true),
				emojis: array(reaction.emojis, 100).map((emoji) => string(emoji, 256, true)),
				count: reaction.count as number | null,
			};
		}),
		unsent: item.unsent,
	};
}

function snapshot(value: unknown): ConversationSnapshot {
	const item = object(value);
	const messages = array(item.messages, 500).map(message);
	if (messages.reduce((size, item) => size + item.text.length + (item.replyTo?.text?.length ?? 0), 0) > 300_000)
		return invalid();
	let mediaCount = 0;
	let mediaChars = 0;
	for (const message of messages) {
		for (const entry of message.attachments) {
			if (entry.type === "image" && entry.media) {
				mediaCount++;
				mediaChars += entry.media.data.length;
			}
		}
	}
	if (mediaCount > MAX_SNAPSHOT_IMAGES || mediaChars > MAX_SNAPSHOT_MEDIA_CHARS) return invalid();
	// Display-only header names. Older extension versions send no field.
	const participants =
		item.participants === undefined
			? []
			: array(item.participants, 10).map((name) => {
					const trimmed = string(name, 512, true).trim();
					if (!trimmed) return invalid();
					return trimmed;
				});
	return { chatId: string(item.chatId), revision: string(item.revision), messages, participants };
}

const actions: readonly TaskControlAction[] = [
	"send-now",
	"edit",
	"save-edit",
	"cancel",
	"pause",
	"resume",
	"take-over",
	"update-goal",
	"answer-agent",
];
const results: readonly SendResult[] = ["sent", "rejected", "uncertain"];

function optionalBoolean(value: unknown): boolean | undefined {
	if (value !== undefined && typeof value !== "boolean") return invalid();
	return value;
}

function delay(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < MIN_REPLY_DELAY_SECONDS) return invalid();
	if ((value as number) > MAX_REPLY_DELAY_SECONDS) return invalid();
	return value as number;
}

// Older extension versions send no settings; the service then keeps its defaults.
function optionalReplySettings(value: unknown): ReplySettings | undefined {
	if (value === undefined) return undefined;
	const item = object(value);
	if (typeof item.autoSend !== "boolean") return invalid();
	const minDelaySeconds = delay(item.minDelaySeconds);
	const maxDelaySeconds = delay(item.maxDelaySeconds);
	if (maxDelaySeconds < minDelaySeconds) return invalid();
	return { autoSend: item.autoSend, minDelaySeconds, maxDelaySeconds };
}

function startInput(value: unknown) {
	const item = object(value);
	return {
		connectorId: string(item.connectorId),
		goal: string(item.goal, 4000),
		snapshot: snapshot(item.snapshot),
		developerMode: optionalBoolean(item.developerMode),
		replySettings: optionalReplySettings(item.replySettings),
	};
}

function controlInput(value: unknown): { connectorId: string; taskId: string; action: TaskControlAction; text?: string } {
	const item = object(value);
	if (typeof item.action !== "string" || !actions.includes(item.action as TaskControlAction)) return invalid();
	const result: { connectorId: string; taskId: string; action: TaskControlAction; text?: string } = {
		connectorId: string(item.connectorId),
		taskId: string(item.taskId),
		action: item.action as TaskControlAction,
	};
	if (item.text !== undefined) result.text = string(item.text, 4000, true);
	return result;
}

function attachInput(value: unknown) {
	const item = object(value);
	return { connectorId: string(item.connectorId), taskId: string(item.taskId), snapshot: snapshot(item.snapshot) };
}

function syncInput(value: unknown) {
	const item = object(value);
	return {
		connectorId: string(item.connectorId),
		snapshot: item.snapshot === null ? null : snapshot(item.snapshot),
		developerMode: optionalBoolean(item.developerMode),
		replySettings: optionalReplySettings(item.replySettings),
	};
}

function authorizeInput(value: unknown) {
	const item = object(value);
	return {
		connectorId: string(item.connectorId),
		commandId: string(item.commandId),
		chatId: string(item.chatId),
		revision: string(item.revision),
	};
}

function reportInput(value: unknown) {
	const item = object(value);
	if (typeof item.result !== "string" || !results.includes(item.result as SendResult)) return invalid();
	return { connectorId: string(item.connectorId), commandId: string(item.commandId), result: item.result as SendResult };
}

function disconnectInput(value: unknown) {
	return { connectorId: string(object(value).connectorId) };
}

function clearInput(value: unknown) {
	const item = object(value);
	return { connectorId: string(item.connectorId), taskId: string(item.taskId) };
}

export const appRouter = t.router({
	health: t.procedure.query((): HealthResponse => ({ status: "ok", service: "envoy-backend" })),
	task: t.router({
		start: t.procedure
			.input(startInput)
			.mutation(({ input }) =>
				service.start(input.connectorId, input.goal, input.snapshot, input.developerMode, input.replySettings),
			),
		attach: t.procedure
			.input(attachInput)
			.mutation(({ input }) => service.attach(input.connectorId, input.taskId, input.snapshot)),
		clear: t.procedure.input(clearInput).mutation(({ input }) => service.clear(input.connectorId, input.taskId)),
		control: t.procedure
			.input(controlInput)
			.mutation(({ input }) => service.control(input.connectorId, input.taskId, input.action, input.text)),
	}),
	connector: t.router({
		sync: t.procedure
			.input(syncInput)
			.mutation(({ input }) =>
				service.sync(input.connectorId, input.snapshot, input.developerMode, input.replySettings),
			),
		authorize: t.procedure
			.input(authorizeInput)
			.mutation(({ input }) => service.authorize(input.connectorId, input.commandId, input.chatId, input.revision)),
		report: t.procedure
			.input(reportInput)
			.mutation(({ input }) => service.report(input.connectorId, input.commandId, input.result)),
		disconnect: t.procedure.input(disconnectInput).mutation(({ input }) => service.disconnect(input.connectorId)),
	}),
});

export type AppRouter = typeof appRouter;
