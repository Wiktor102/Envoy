import { test } from "node:test";
import assert from "node:assert/strict";
import { appRouter } from "../src/router.js";

const caller = appRouter.createCaller({});
const message = {
	id: "id",
	text: "hello",
	direction: "incoming",
	replyTo: null,
	attachments: [],
	reactions: [],
	unsent: false,
};
const snapshot = { chatId: "chat", revision: "rev", messages: [message] };

test("task and connector procedures reject invalid or oversized inputs without leaking text", async () => {
	const secret = "message content that should not appear in an error";
	const cases = [
		() => caller.task.start({ connectorId: "owner", goal: "goal", snapshot, developerMode: "true" } as never),
		() => caller.connector.sync({ connectorId: "owner", snapshot, developerMode: 1 } as never),
		() => caller.task.start({ connectorId: "", goal: "goal", snapshot } as never),
		() => caller.task.start({ connectorId: "owner", goal: " ", snapshot } as never),
		() =>
			caller.task.start({
				connectorId: "owner",
				goal: "goal",
				snapshot: { ...snapshot, messages: [{ ...message, text: secret, direction: "unclear" }] },
			} as never),
		() =>
			caller.connector.sync({
				connectorId: "owner",
				snapshot: { ...snapshot, messages: [{ ...message, unsent: undefined }] },
			} as never),
		() =>
			caller.connector.sync({
				connectorId: "owner",
				snapshot: { ...snapshot, messages: Array(501).fill(message) },
			} as never),
		() => caller.connector.report({ connectorId: "owner", commandId: "cmd", result: "retry" } as never),
	];
	for (const action of cases) {
		await assert.rejects(action, (error: unknown) => {
			assert.equal((error as { code: string }).code, "BAD_REQUEST");
			assert.doesNotMatch((error as Error).message, /message content that should not appear/);
			return true;
		});
	}
});

test("connector sync accepts video attachments as unavailable media", async () => {
	const videoSnapshot = {
		...snapshot,
		messages: [{ ...message, attachments: [{ type: "video", url: null, description: null }] }],
	};
	const result = await caller.connector.sync({ connectorId: "owner", snapshot: videoSnapshot });
	assert.equal(result.task, null);
	await assert.rejects(
		caller.connector.sync({
			connectorId: "owner",
			snapshot: {
				...snapshot,
				messages: [
					{ ...message, attachments: [{ type: "video", url: "https://example.test/v", description: null }] },
				],
			},
		} as never),
		(error: unknown) => (error as { code: string }).code === "BAD_REQUEST",
	);
});

test("connector sync accepts sticker attachments as unavailable media", async () => {
	const stickerSnapshot = {
		...snapshot,
		messages: [{ ...message, attachments: [{ type: "sticker", url: null, description: null }] }],
	};
	const result = await caller.connector.sync({ connectorId: "owner", snapshot: stickerSnapshot });
	assert.equal(result.task, null);
	await assert.rejects(
		caller.connector.sync({
			connectorId: "owner",
			snapshot: {
				...snapshot,
				messages: [
					{
						...message,
						attachments: [{ type: "sticker", url: "https://example.test/s", description: null }],
					},
				],
			},
		} as never),
		(error: unknown) => (error as { code: string }).code === "BAD_REQUEST",
	);
});
