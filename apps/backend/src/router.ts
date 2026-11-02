import { initTRPC, TRPCError } from "@trpc/server";
import type {
	ConversationMessage,
	ConversationSnapshot,
	HealthResponse,
	InlineImageMedia,
	MessageAttachment,
	ReplySettings,
	SendResult,
	TaskControlAction,
} from "@envoy/contracts";
import {
	INLINE_IMAGE_MIMES,
	MAX_IMAGE_SIDE,
	MAX_INLINE_MEDIA_CHARS,
	MAX_REPLY_DELAY_SECONDS,
	MAX_SNAPSHOT_IMAGES,
	MAX_SNAPSHOT_MEDIA_CHARS,
	MAX_TASK_TEXT_LENGTH,
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

function string(value: unknown, max = MAX_ID_LENGTH, allowEmpty = false): string {
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

// Shared bounds for the shapes below. One edit point when a limit changes.
const MAX_ID_LENGTH = 512;
const MAX_URL_LENGTH = 8192;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_TEXT_LENGTH = 20_000;
const MAX_ATTACHMENTS = 50;
const MAX_REACTIONS = 100;
const MAX_EMOJIS = 100;
const MAX_MESSAGES = 500;
const MAX_PARTICIPANTS = 10;

function inlineMedia(value: unknown): InlineImageMedia {
	const item = object(value);
	const mime = enumOf(item.mime, INLINE_IMAGE_MIMES);
	if (
		typeof item.data !== "string" ||
		!item.data.length ||
		item.data.length > MAX_INLINE_MEDIA_CHARS ||
		item.data.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)
	)
		return invalid();
	return {
		mime,
		data: item.data,
		width: intInRange(item.width, 1, MAX_IMAGE_SIDE),
		height: intInRange(item.height, 1, MAX_IMAGE_SIDE),
	};
}

// Reply quotes stay type-only: their bytes never reach the backend.
function optMedia(value: unknown, allowMedia: boolean): InlineImageMedia | null {
	if (value == null) return null;
	return allowMedia ? inlineMedia(value) : invalid();
}

function attachment(value: unknown, allowMedia: boolean): MessageAttachment {
	const item = object(value);
	// Files stay presence-only. Their bytes never reach the backend.
	if (item.type === "file") {
		for (const key of ["url", "description", "media"] as const) {
			if (item[key] != null) return invalid();
		}
		return { type: "file" };
	}
	const type = enumOf(item.type, ["image", "video", "sticker", "gif"] as const);
	const media = optMedia(item.media, allowMedia);
	if (type === "image") {
		return {
			type,
			url: optionalText(item.url, MAX_URL_LENGTH),
			description: optionalText(item.description, MAX_DESCRIPTION_LENGTH),
			media,
		};
	}
	if (item.description != null) return invalid();
	return { type, url: optionalText(item.url, MAX_URL_LENGTH), description: null, media };
}

function message(value: unknown): ConversationMessage {
	const item = object(value);
	const direction = enumOf(item.direction, ["incoming", "outgoing", "unknown", "system"] as const);
	if (typeof item.unsent !== "boolean") return invalid();
	if (item.edited != null && typeof item.edited !== "boolean") return invalid();
	const reply = item.replyTo === null ? null : object(item.replyTo);
	return {
		id: string(item.id),
		// Stable matching key and edited marker. Older extension versions send
		// no field; both default to unknown.
		stableId: optionalText(item.stableId ?? null, MAX_ID_LENGTH) || null,
		edited: (item.edited as boolean | null | undefined) ?? null,
		text: string(item.text, MAX_TEXT_LENGTH, true),
		direction,
		// Per-message display label. Older extension versions send no field.
		sender: optionalText(item.sender ?? null, MAX_ID_LENGTH),
		replyTo: reply && {
			text: optionalText(reply.text, MAX_TEXT_LENGTH),
			context: optionalText(reply.context, MAX_DESCRIPTION_LENGTH),
			attachments: array(reply.attachments, MAX_ATTACHMENTS).map((value) => attachment(value, false)),
		},
		attachments: array(item.attachments, MAX_ATTACHMENTS).map((value) => attachment(value, true)),
		reactions: array(item.reactions, MAX_REACTIONS).map((value) => {
			const reaction = object(value);
			if (reaction.count !== null && (!Number.isSafeInteger(reaction.count) || (reaction.count as number) < 0))
				return invalid();
			return {
				label: string(reaction.label, MAX_DESCRIPTION_LENGTH, true),
				emojis: array(reaction.emojis, MAX_EMOJIS).map((emoji) => string(emoji, 256, true)),
				count: reaction.count as number | null,
			};
		}),
		unsent: item.unsent,
	};
}

function snapshot(value: unknown): ConversationSnapshot {
	const item = object(value);
	const messages = array(item.messages, MAX_MESSAGES).map(message);
	if (messages.reduce((size, item) => size + item.text.length + (item.replyTo?.text?.length ?? 0), 0) > 300_000)
		return invalid();
	let mediaCount = 0;
	let mediaChars = 0;
	for (const message of messages) {
		for (const entry of message.attachments) {
			// Files stay presence-only and never carry media bytes.
			if (entry.type !== "file" && entry.media) {
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
			: array(item.participants, MAX_PARTICIPANTS).map((name) => {
					const trimmed = string(name, MAX_ID_LENGTH, true).trim();
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

function intInRange(value: unknown, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return invalid();
	return value as number;
}

function enumOf<T extends string>(value: unknown, list: readonly T[]): T {
	if (typeof value !== "string" || !(list as readonly string[]).includes(value)) return invalid();
	return value as T;
}

function delay(value: unknown): number {
	return intInRange(value, MIN_REPLY_DELAY_SECONDS, MAX_REPLY_DELAY_SECONDS);
}

function cid(item: Record<string, unknown>): string {
	return string(item.connectorId);
}

function tid(item: Record<string, unknown>): string {
	return string(item.taskId);
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
		connectorId: cid(item),
		goal: string(item.goal, MAX_TASK_TEXT_LENGTH),
		snapshot: snapshot(item.snapshot),
		developerMode: optionalBoolean(item.developerMode),
		replySettings: optionalReplySettings(item.replySettings),
	};
}

function controlInput(value: unknown): { connectorId: string; taskId: string; action: TaskControlAction; text?: string } {
	const item = object(value);
	const result: { connectorId: string; taskId: string; action: TaskControlAction; text?: string } = {
		connectorId: cid(item),
		taskId: tid(item),
		action: enumOf(item.action, actions),
	};
	if (item.text !== undefined) result.text = string(item.text, MAX_TASK_TEXT_LENGTH, true);
	return result;
}

function attachInput(value: unknown) {
	const item = object(value);
	return { connectorId: cid(item), taskId: tid(item), snapshot: snapshot(item.snapshot) };
}

function syncInput(value: unknown) {
	const item = object(value);
	return {
		connectorId: cid(item),
		snapshot: item.snapshot === null ? null : snapshot(item.snapshot),
		developerMode: optionalBoolean(item.developerMode),
		replySettings: optionalReplySettings(item.replySettings),
	};
}

function authorizeInput(value: unknown) {
	const item = object(value);
	return {
		connectorId: cid(item),
		commandId: string(item.commandId),
		chatId: string(item.chatId),
		revision: string(item.revision),
	};
}

function reportInput(value: unknown) {
	const item = object(value);
	return { connectorId: cid(item), commandId: string(item.commandId), result: enumOf(item.result, results) };
}

function disconnectInput(value: unknown) {
	return { connectorId: cid(object(value)) };
}

function clearInput(value: unknown) {
	const item = object(value);
	return { connectorId: cid(item), taskId: tid(item) };
}

export const healthResponse: HealthResponse = { status: "ok", service: "envoy-backend" };

export const appRouter = t.router({
	health: t.procedure.query((): HealthResponse => healthResponse),
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
