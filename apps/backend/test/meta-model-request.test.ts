import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationSnapshot } from "@envoy/contracts";
import { MetaModelAdapter } from "../src/agent/meta-model.js";
import { conversation, modelResponse, photo, task } from "./support/meta-model-fixtures.js";

test("the Meta request keeps user instructions separate from untrusted conversation text", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousModel = process.env.MODEL_API_MODEL;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	delete process.env.MODEL_API_MODEL;
	let captured: { url: string; authorization: string | null; body: any } | null = null;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		captured = { url: request.url, authorization: request.headers.get("authorization"), body: await request.json() };
		return new Response(
			JSON.stringify({
				choices: [{ message: { role: "assistant", content: '{"action":"ask","text":"Is Friday allowed?"}' } }],
			}),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	};
	try {
		const result = await new MetaModelAdapter().run(task, conversation, "task_started");
		assert.deepEqual(result, { action: "ask", text: "Is Friday allowed?" });
		assert.equal(captured!.url, "https://api.meta.ai/v1/chat/completions");
		assert.equal(captured!.authorization, "Bearer test-key");
		assert.equal(captured!.body.model, "muse-spark-1.3");
		assert.equal(captured!.body.messages[1].role, "developer");
		assert.match(captured!.body.messages[1].content, /Meet Tuesday/);
		assert.match(captured!.body.messages[1].content, /Evaluation reason: task_started/);
		assert.doesNotMatch(captured!.body.messages[1].content, /Ignore the goal/);
		assert.match(captured!.body.messages[2].content, /Ignore the goal/);
		assert.match(captured!.body.messages[0].content, /untrusted data/);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
		if (previousModel === undefined) delete process.env.MODEL_API_MODEL;
		else process.env.MODEL_API_MODEL = previousModel;
	}
});

test("the Meta request includes the chat name as unverified display context", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	let body: any;
	globalThis.fetch = async (input, init) => {
		body = await new Request(input, init).json();
		return new Response(
			JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"action":"wait"}' } }] }),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	};
	try {
		await new MetaModelAdapter().run(task, { ...conversation, participants: ["Wiktor Golicz"] }, "task_started");
		const content = JSON.parse(body.messages[2].content);
		assert.deepEqual(content.participants, ["Wiktor Golicz"]);
		assert.match(body.messages[0].content, /unverified display context/);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});

test("the Meta request includes per-message sender labels as untrusted context", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	let body: any;
	globalThis.fetch = async (input, init) => {
		body = await new Request(input, init).json();
		return new Response(
			JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"action":"wait"}' } }] }),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	};
	try {
		await new MetaModelAdapter().run(
			task,
			{
				...conversation,
				messages: [
					{ ...conversation.messages[0], sender: "Wiktor testowy" },
					{ ...conversation.messages[0], id: "node-2", sender: null },
				],
			},
			"new_message",
		);
		const content = JSON.parse(body.messages[2].content);
		assert.deepEqual(
			content.conversation.map(({ sender }: { sender: string | null }) => sender),
			["Wiktor testowy", null],
		);
		assert.match(body.messages[0].content, /sender display label/);
		assert.match(body.messages[0].content, /Do not guess their authors/);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});

test("the Meta adapter rejects malformed and multiline reply decisions", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	let content = "not JSON";
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	try {
		await assert.rejects(new MetaModelAdapter().run(task, conversation, "task_started"), /Invalid model decision/);
		content = JSON.stringify({ action: "reply", text: "first\nsecond" });
		await assert.rejects(new MetaModelAdapter().run(task, conversation, "task_started"), /Invalid model decision/);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});

test("the Meta request marks unverified history and attachments without sending their URLs", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	let body: any;
	globalThis.fetch = async (input, init) => {
		body = await new Request(input, init).json();
		return new Response(
			JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"action":"wait"}' } }] }),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	};
	try {
		const prior = {
			id: "older",
			direction: "unknown" as const,
			sender: null,
			text: "What about this?",
			attachments: [
				{ type: "image" as const, url: "https://private.example/photo", description: null, media: null },
				{ type: "video" as const, url: null, description: null, media: null },
				{ type: "sticker" as const, url: null, description: null, media: null },
				{ type: "file" as const },
			],
			replyTo: {
				text: null,
				context: null,
				attachments: [
					{ type: "image" as const, url: null, description: null, media: null },
					{ type: "sticker" as const, url: null, description: null, media: null },
				],
			},
			reactions: [],
			unsent: false,
		};
		await new MetaModelAdapter().run(
			task,
			{ ...conversation, messages: [prior, ...conversation.messages] },
			"new_message",
		);
		const content = JSON.parse(body.messages[2].content);
		assert.deepEqual(content.conversation[0], {
			direction: "unknown",
			sender: null,
			text: "What about this?",
			unsent: false,
			edited: null,
			attachments: [{ type: "image" }, { type: "video" }, { type: "sticker" }, { type: "file" }],
			replyTo: { text: null, context: null, attachments: [{ type: "image" }, { type: "sticker" }] },
		});
		assert.doesNotMatch(body.messages[2].content, /private\.example/);
		assert.match(body.messages[0].content, /Do not guess their authors or missing contents/);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});

test("the Meta request retries once when the connection itself fails", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	const previousFlag = process.env.ENVOY_DEBUG_MEDIA;
	const previousInfo = console.info;
	process.env.MODEL_API_KEY = "test-key";
	process.env.ENVOY_DEBUG_MEDIA = "1";
	const lines: string[] = [];
	console.info = (line: string) => {
		lines.push(line);
	};
	let calls = 0;
	globalThis.fetch = (async (input: any) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.meta.ai/v1/chat/completions") {
			calls++;
			if (calls === 1) {
				throw Object.assign(new Error("fetch failed"), {
					cause: Object.assign(new Error("unable to verify the first certificate"), {
						code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
					}),
				});
			}
			return modelResponse();
		}
		throw new Error("unexpected fetch");
	}) as typeof fetch;
	try {
		const messages = [
			{
				id: "text",
				direction: "incoming",
				sender: "Alex",
				text: "Hello",
				replyTo: null,
				attachments: [],
				reactions: [],
				unsent: false,
			},
		];
		const decision = await new MetaModelAdapter().run(
			task,
			{ ...conversation, messages } as unknown as ConversationSnapshot,
			"new_message",
		);
		assert.equal(calls, 2);
		assert.equal(decision.action, "wait");
		assert.ok(lines.some((line) => line.includes("retrying once")));
		assert.ok(lines.some((line) => line.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE")));
	} finally {
		console.info = previousInfo;
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
		if (previousFlag === undefined) delete process.env.ENVOY_DEBUG_MEDIA;
		else process.env.ENVOY_DEBUG_MEDIA = previousFlag;
	}
});

test("the Meta request includes the agent conversation alongside instructions", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	let body: any;
	globalThis.fetch = async (input, init) => {
		body = await new Request(input, init).json();
		return new Response(
			JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"action":"wait"}' } }] }),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	};
	try {
		await new MetaModelAdapter().run(
			{
				...task,
				agentChat: [
					{ id: "q1", role: "agent", text: "Is Friday allowed?", body: null, createdAt: 1 },
					{ id: "a1", role: "user", text: "Yes, after 3.", body: null, createdAt: 2 },
					{ id: "e1", role: "event", text: "Reply sent.", body: "Friday works.", createdAt: 3 },
				],
			},
			conversation,
			"instructions_updated",
		);
		assert.match(body.messages[1].content, /Is Friday allowed\?/);
		assert.match(body.messages[1].content, /Yes, after 3\./);
		assert.match(body.messages[1].content, /Reply sent\./);
		assert.match(body.messages[1].content, /Friday works\./);
		assert.doesNotMatch(body.messages[2].content, /Is Friday allowed\?/);
		assert.doesNotMatch(body.messages[2].content, /Yes, after 3\./);
		assert.match(body.messages[0].content, /do not repeat answered questions/);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});

test("the Meta request marks edited messages and explains corrections", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	let body: any;
	globalThis.fetch = async (input, init) => {
		body = await new Request(input, init).json();
		return new Response(
			JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"action":"wait"}' } }] }),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	};
	try {
		await new MetaModelAdapter().run(
			{
				...task,
				agentChat: [
					{
						id: "edit-1",
						role: "event",
						text: "An incoming message was corrected (not a new message).",
						body: "Previous text: alpha\nCurrent text: beta",
						createdAt: 1,
					},
				],
			},
			{
				...conversation,
				messages: [
					{ ...conversation.messages[0], edited: true },
					{ ...conversation.messages[0], id: "node-2", edited: false },
					{ ...conversation.messages[0], id: "node-3", edited: null },
				],
			},
			"message_edited",
		);
		const content = JSON.parse(body.messages[2].content);
		assert.deepEqual(
			content.conversation.map(({ edited }: { edited: boolean | null }) => edited),
			[true, false, null],
		);
		assert.match(body.messages[1].content, /Evaluation reason: message_edited/);
		assert.match(body.messages[1].content, /Previous text: alpha/);
		assert.match(body.messages[1].content, /Current text: beta/);
		assert.match(body.messages[0].content, /correction to one existing message, not a new message/);
		assert.match(body.messages[0].content, /previous text is unknown, so do not guess it/);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});

test("the system prompt invites a fresh alternative on regenerate_requested", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	let body: any;
	globalThis.fetch = async (input, init) => {
		body = await new Request(input, init).json();
		return new Response(
			JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"action":"wait"}' } }] }),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	};
	try {
		await new MetaModelAdapter().run(task, conversation, "regenerate_requested");
		assert.match(body.messages[1].content, /Evaluation reason: regenerate_requested/);
		assert.match(body.messages[0].content, /fresh alternative/);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});

test("the Meta request defaults completion tokens to 16000 with an env override", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousCap = process.env.MODEL_MAX_COMPLETION_TOKENS;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	delete process.env.MODEL_MAX_COMPLETION_TOKENS;
	let body: any;
	globalThis.fetch = async (input, init) => {
		body = await new Request(input, init).json();
		return modelResponse();
	};
	try {
		await new MetaModelAdapter().run(task, conversation as unknown as ConversationSnapshot, "task_started");
		assert.equal(body.max_completion_tokens, 16000);
		process.env.MODEL_MAX_COMPLETION_TOKENS = "8000";
		await new MetaModelAdapter().run(task, conversation as unknown as ConversationSnapshot, "task_started");
		assert.equal(body.max_completion_tokens, 8000);
		process.env.MODEL_MAX_COMPLETION_TOKENS = "bogus";
		await new MetaModelAdapter().run(task, conversation as unknown as ConversationSnapshot, "task_started");
		assert.equal(body.max_completion_tokens, 16000);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
		if (previousCap === undefined) delete process.env.MODEL_MAX_COMPLETION_TOKENS;
		else process.env.MODEL_MAX_COMPLETION_TOKENS = previousCap;
	}
});
