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
		() =>
			caller.connector.sync({
				connectorId: "owner",
				snapshot: { ...snapshot, participants: ["Wiktor Golicz", 42] },
			} as never),
		() =>
			caller.connector.sync({
				connectorId: "owner",
				snapshot: { ...snapshot, participants: ["   "] },
			} as never),
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

test("connector sync accepts participant display names and older snapshots without them", async () => {
	const named = await caller.connector.sync({
		connectorId: "owner",
		snapshot: { ...snapshot, participants: ["Wiktor Golicz"] },
	});
	assert.equal(named.task, null);
	const legacy = await caller.connector.sync({ connectorId: "owner", snapshot });
	assert.equal(legacy.task, null);
});

test("connector sync accepts per-message sender labels and older messages without them", async () => {
	const named = await caller.connector.sync({
		connectorId: "owner",
		snapshot: { ...snapshot, messages: [{ ...message, sender: "Wiktor testowy" }] },
	});
	assert.equal(named.task, null);
	const unknown = await caller.connector.sync({
		connectorId: "owner",
		snapshot: { ...snapshot, messages: [{ ...message, sender: null }] },
	});
	assert.equal(unknown.task, null);
	const legacy = await caller.connector.sync({ connectorId: "owner", snapshot });
	assert.equal(legacy.task, null);
	for (const sender of [42, "x".repeat(513), ["Alex"]]) {
		await assert.rejects(
			caller.connector.sync({
				connectorId: "owner",
				snapshot: { ...snapshot, messages: [{ ...message, sender }] },
			} as never),
			(error: unknown) => (error as { code: string }).code === "BAD_REQUEST",
		);
	}
});

test("connector sync accepts bounded inline photo bytes and older images without them", async () => {
	const media = { mime: "image/jpeg", data: "AAAA".repeat(256), width: 1568, height: 900 };
	const accepted = await caller.connector.sync({
		connectorId: "owner",
		snapshot: {
			...snapshot,
			messages: [{ ...message, attachments: [{ type: "image", url: null, description: null, media }] }],
		},
	});
	assert.equal(accepted.task, null);
	const legacy = await caller.connector.sync({
		connectorId: "owner",
		snapshot: {
			...snapshot,
			messages: [{ ...message, attachments: [{ type: "image", url: null, description: null }] }],
		},
	});
	assert.equal(legacy.task, null);
	const invalid = [
		{ ...media, mime: "image/gif" },
		{ ...media, mime: "text/plain" },
		{ ...media, data: "" },
		{ ...media, data: "AAAA".repeat(250_001) },
		{ ...media, data: "!!!" },
		{ ...media, data: "AAAAA" },
		{ ...media, width: 0 },
		{ ...media, width: 1569 },
		{ ...media, height: -4 },
		{ ...media, height: 2000 },
		"not-an-object",
	];
	for (const bad of invalid) {
		await assert.rejects(
			caller.connector.sync({
				connectorId: "owner",
				snapshot: {
					...snapshot,
					messages: [{ ...message, attachments: [{ type: "image", url: null, description: null, media: bad }] }],
				},
			} as never),
			(error: unknown) => (error as { code: string }).code === "BAD_REQUEST",
		);
	}
});

test("connector sync rejects quote bytes and snapshots past the media caps", async () => {
	const media = { mime: "image/png", data: "AAAA", width: 4, height: 4 };
	await assert.rejects(
		caller.connector.sync({
			connectorId: "owner",
			snapshot: {
				...snapshot,
				messages: [
					{
						...message,
						replyTo: {
							text: "Original",
							context: "Reply",
							attachments: [{ type: "image", url: null, description: null, media }],
						},
					},
				],
			},
		} as never),
		(error: unknown) => (error as { code: string }).code === "BAD_REQUEST",
	);
	const photo = { type: "image", url: null, description: null, media };
	await assert.rejects(
		caller.connector.sync({
			connectorId: "owner",
			snapshot: { ...snapshot, messages: [{ ...message, attachments: [photo, photo, photo, photo, photo] }] },
		} as never),
		(error: unknown) => (error as { code: string }).code === "BAD_REQUEST",
	);
	const big = { ...media, data: "AAAA".repeat(200_000) };
	const bigPhoto = { type: "image", url: null, description: null, media: big };
	await assert.rejects(
		caller.connector.sync({
			connectorId: "owner",
			snapshot: { ...snapshot, messages: [{ ...message, attachments: [bigPhoto, bigPhoto, bigPhoto, bigPhoto] }] },
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

test("connector sync accepts gif attachments as unavailable media", async () => {
	const gifSnapshot = {
		...snapshot,
		messages: [{ ...message, attachments: [{ type: "gif", url: null, description: null }] }],
	};
	const result = await caller.connector.sync({ connectorId: "owner", snapshot: gifSnapshot });
	assert.equal(result.task, null);
	await assert.rejects(
		caller.connector.sync({
			connectorId: "owner",
			snapshot: {
				...snapshot,
				messages: [
					{
						...message,
						attachments: [{ type: "gif", url: "https://example.test/g", description: null }],
					},
				],
			},
		} as never),
		(error: unknown) => (error as { code: string }).code === "BAD_REQUEST",
	);
});

test("reply settings must be whole seconds in an ordered, bounded range", async () => {
	const valid = { autoSend: false, minDelaySeconds: 1, maxDelaySeconds: 600 };
	assert.equal((await caller.connector.sync({ connectorId: "owner", snapshot, replySettings: valid })).task, null);
	for (const replySettings of [
		null,
		{ ...valid, autoSend: "false" },
		{ ...valid, minDelaySeconds: 0 },
		{ ...valid, maxDelaySeconds: 601 },
		{ ...valid, minDelaySeconds: 1.5 },
		{ ...valid, minDelaySeconds: 20, maxDelaySeconds: 10 },
		{ autoSend: true },
	]) {
		await assert.rejects(
			caller.connector.sync({ connectorId: "owner", snapshot, replySettings } as never),
			(error: unknown) => (error as { code: string }).code === "BAD_REQUEST",
		);
	}
});
