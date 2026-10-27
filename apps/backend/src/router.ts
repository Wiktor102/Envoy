import { initTRPC, TRPCError } from "@trpc/server";
import type {
	ConversationMessage,
	ConversationSnapshot,
	HealthResponse,
	ImageAttachment,
	SendResult,
	TaskControlAction,
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

function attachment(value: unknown): ImageAttachment {
	const item = object(value);
	if (item.type !== "image") return invalid();
	return { type: "image", url: optionalText(item.url, 8192), description: optionalText(item.description, 4000) };
}

function message(value: unknown): ConversationMessage {
	const item = object(value);
	const direction = item.direction;
	if (direction !== "incoming" && direction !== "outgoing" && direction !== "unknown" && direction !== "system")
		return invalid();
	const reply = item.replyTo === null ? null : object(item.replyTo);
	return {
		id: string(item.id),
		text: string(item.text, 20_000, true),
		direction,
		replyTo: reply && {
			text: optionalText(reply.text, 20_000),
			context: optionalText(reply.context, 4000),
			attachments: array(reply.attachments, 50).map(attachment),
		},
		attachments: array(item.attachments, 50).map(attachment),
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
	};
}

function snapshot(value: unknown): ConversationSnapshot {
	const item = object(value);
	const messages = array(item.messages, 500).map(message);
	if (messages.reduce((size, item) => size + item.text.length + (item.replyTo?.text?.length ?? 0), 0) > 300_000)
		return invalid();
	return { chatId: string(item.chatId), revision: string(item.revision), messages };
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
];
const results: readonly SendResult[] = ["sent", "rejected", "uncertain"];

function startInput(value: unknown) {
	const item = object(value);
	return { connectorId: string(item.connectorId), goal: string(item.goal, 4000), snapshot: snapshot(item.snapshot) };
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
	return { connectorId: string(item.connectorId), snapshot: item.snapshot === null ? null : snapshot(item.snapshot) };
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
			.mutation(({ input }) => service.start(input.connectorId, input.goal, input.snapshot)),
		attach: t.procedure
			.input(attachInput)
			.mutation(({ input }) => service.attach(input.connectorId, input.taskId, input.snapshot)),
		clear: t.procedure.input(clearInput).mutation(({ input }) => service.clear(input.connectorId, input.taskId)),
		control: t.procedure
			.input(controlInput)
			.mutation(({ input }) => service.control(input.connectorId, input.taskId, input.action, input.text)),
	}),
	connector: t.router({
		sync: t.procedure.input(syncInput).mutation(({ input }) => service.sync(input.connectorId, input.snapshot)),
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
