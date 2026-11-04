import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationSnapshot } from "@envoy/contracts";
import { MetaModelAdapter } from "../src/agent/meta-model.js";
import { conversation, modelResponse, task } from "./support/meta-model-fixtures.js";

async function decisionFailure(choice: unknown, usage?: unknown): Promise<string[]> {
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
	const body: Record<string, unknown> = { choices: [choice] };
	if (usage !== undefined) body.usage = usage;
	globalThis.fetch = (async (input: any) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.meta.ai/v1/chat/completions") {
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error("unexpected fetch");
	}) as typeof fetch;
	try {
		await new MetaModelAdapter().run(task, conversation as unknown as ConversationSnapshot, "new_message");
		assert.fail("expected an Invalid model decision error");
	} catch (error) {
		assert.equal((error as Error).message, "Invalid model decision");
		return lines;
	} finally {
		console.info = previousInfo;
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
		if (previousFlag === undefined) delete process.env.ENVOY_DEBUG_MEDIA;
		else process.env.ENVOY_DEBUG_MEDIA = previousFlag;
	}
}

test("the media debug log narrates fetches and blocks without URLs or text", async () => {
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
	const clipBytes = Buffer.from("fake-mp4-bytes");
	globalThis.fetch = (async (input: any, init: any) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.meta.ai/v1/chat/completions") return modelResponse();
		return new Response(clipBytes as unknown as BodyInit, {
			status: 200,
			headers: { "content-type": "video/mp4" },
		});
	}) as typeof fetch;
	try {
		const messages = [
			{
				id: "clip",
				direction: "incoming",
				sender: "Alex",
				text: "Watch this",
				replyTo: null,
				attachments: [{ type: "video", url: "https://example.test/clip.mp4", description: null, media: null }],
				reactions: [],
				unsent: false,
			},
		];
		await new MetaModelAdapter().run(
			task,
			{ ...conversation, messages } as unknown as ConversationSnapshot,
			"new_message",
		);
		assert.ok(lines.some((line) => line.includes("fetch video/mp4")));
		assert.ok(lines.some((line) => line.includes("media video url -> video block")));
		assert.ok(lines.some((line) => line.includes("0 image blocks [], 1 video blocks [14B]")));
		assert.ok(!lines.join("\n").includes("example.test"));
		assert.ok(!lines.join("\n").includes("Watch this"));
	} finally {
		console.info = previousInfo;
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
		if (previousFlag === undefined) delete process.env.ENVOY_DEBUG_MEDIA;
		else process.env.ENVOY_DEBUG_MEDIA = previousFlag;
	}
});

test("the media debug log records request failures by status only", async () => {
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
	globalThis.fetch = (async (input: any) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.meta.ai/v1/chat/completions") {
			return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 500 });
		}
		throw new Error("unexpected fetch");
	}) as typeof fetch;
	try {
		await assert.rejects(
			new MetaModelAdapter().run(task, conversation as unknown as ConversationSnapshot, "new_message"),
		);
		assert.ok(lines.some((line) => line.includes("request failed: status 500 (InternalServerError)")));
		assert.ok(!lines.join("\n").includes("busy"));
	} finally {
		console.info = previousInfo;
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
		if (previousFlag === undefined) delete process.env.ENVOY_DEBUG_MEDIA;
		else process.env.ENVOY_DEBUG_MEDIA = previousFlag;
	}
});

test("the media debug log marks unparsable model decisions without their text", async () => {
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
	globalThis.fetch = (async (input: any) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.meta.ai/v1/chat/completions") {
			return new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		throw new Error("unexpected fetch");
	}) as typeof fetch;
	try {
		await assert.rejects(
			new MetaModelAdapter().run(task, conversation as unknown as ConversationSnapshot, "new_message"),
			(error: unknown) => (error as Error).message === "Invalid model decision",
		);
		assert.ok(lines.some((line) => line.includes("model decision unparsable")));
		assert.ok(!lines.join("\n").includes("not json"));
	} finally {
		console.info = previousInfo;
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
		if (previousFlag === undefined) delete process.env.ENVOY_DEBUG_MEDIA;
		else process.env.ENVOY_DEBUG_MEDIA = previousFlag;
	}
});

test("the media debug log describes an empty model response with its finish reason", async () => {
	const lines = await decisionFailure({ message: { content: "" }, finish_reason: "stop" });
	const line = lines.find((candidate) => candidate.includes("model decision unparsable"));
	assert.ok(line);
	assert.match(line, /choices 1/);
	assert.match(line, /finish stop/);
	assert.match(line, /content empty/);
	assert.match(line, /refusal none/);
	assert.match(line, /tool calls 0/);
	assert.match(line, /usage none/);
});

test("the media debug log reports a refusal by length without its text", async () => {
	const refusal = "I cannot look at images of any kind whatsoever in this evaluation";
	const lines = await decisionFailure({ message: { content: null, refusal }, finish_reason: "stop" });
	const line = lines.find((candidate) => candidate.includes("model decision unparsable"));
	assert.ok(line);
	assert.match(line, /content null/);
	assert.match(line, new RegExp(`refusal ${refusal.length} chars`));
	assert.ok(!lines.join("\n").includes(refusal));
});

test("the media debug log reports a length finish with reasoning usage", async () => {
	const lines = await decisionFailure(
		{ message: {}, finish_reason: "length" },
		{
			prompt_tokens: 81,
			completion_tokens: 72,
			total_tokens: 211,
			completion_tokens_details: { reasoning_tokens: 58 },
		},
	);
	const line = lines.find((candidate) => candidate.includes("model decision unparsable"));
	assert.ok(line);
	assert.match(line, /finish length/);
	assert.match(line, /content missing/);
	assert.match(line, /usage \[prompt 81, completion 72, total 211, reasoning 58\]/);
});

test("the media debug log counts tool calls without their arguments", async () => {
	const lines = await decisionFailure({
		message: {
			tool_calls: [
				{ id: "a", function: { name: "send", arguments: '{"private":"s3cret-payload-one"}' } },
				{ id: "b", function: { name: "send", arguments: '{"private":"s3cret-payload-two"}' } },
			],
		},
		finish_reason: "tool_calls",
	});
	const line = lines.find((candidate) => candidate.includes("model decision unparsable"));
	assert.ok(line);
	assert.match(line, /tool calls 2/);
	assert.match(line, /content missing/);
	assert.match(line, /usage none/);
	assert.ok(!lines.join("\n").includes("s3cret-payload"));
});

test("the media debug log survives a bare choice with unlisted metadata", async () => {
	const lines = await decisionFailure({ finish_reason: "pause" });
	const line = lines.find((candidate) => candidate.includes("model decision unparsable"));
	assert.ok(line);
	assert.match(line, /choices 1/);
	assert.match(line, /finish unlisted/);
	assert.match(line, /content missing/);
	assert.match(line, /refusal none/);
	assert.match(line, /tool calls 0/);
	assert.match(line, /usage none/);
});

test("the media debug log describes a well-formed but invalid decision without its text", async () => {
	const lines = await decisionFailure(
		{ message: { content: '{"action":"dance"}' }, finish_reason: "stop" },
		{ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
	);
	const line = lines.find((candidate) => candidate.includes("model decision invalid"));
	assert.ok(line);
	assert.match(line, /finish stop/);
	assert.match(line, /content present 18 chars/);
	assert.match(line, /usage \[prompt 10, completion 5, total 15\]/);
	assert.ok(!lines.join("\n").includes("dance"));
});

test("the media debug log records the connection cause without request data", async () => {
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
	// Undici wraps the transport error: an outer "fetch failed" whose cause
	// carries the specific network code.
	const socketError = Object.assign(new Error("fetch failed"), {
		cause: Object.assign(new Error("socket hang up"), { code: "UND_ERR_SOCKET" }),
	});
	globalThis.fetch = (async (input: any) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.meta.ai/v1/chat/completions") throw socketError;
		throw new Error("unexpected fetch");
	}) as typeof fetch;
	try {
		const messages = [
			{
				id: "clip",
				direction: "incoming",
				sender: "Alex",
				text: "Watch this",
				replyTo: null,
				attachments: [{ type: "video", url: "https://example.test/clip.mp4", description: null, media: null }],
				reactions: [],
				unsent: false,
			},
		];
		await assert.rejects(
			new MetaModelAdapter().run(
				task,
				{ ...conversation, messages } as unknown as ConversationSnapshot,
				"new_message",
			),
		);
		assert.ok(lines.some((line) => line.includes("APIConnectionError")));
		assert.ok(lines.some((line) => line.includes("UND_ERR_SOCKET") && line.includes("socket hang up")));
		assert.ok(!lines.join("\n").includes("Watch this"));
	} finally {
		console.info = previousInfo;
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
		if (previousFlag === undefined) delete process.env.ENVOY_DEBUG_MEDIA;
		else process.env.ENVOY_DEBUG_MEDIA = previousFlag;
	}
});
