import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import type { ConversationSnapshot, ImageAttachment } from "@envoy/contracts";
import { MetaModelAdapter } from "../src/agent/meta-model.js";
import { conversation, modelResponse, photo, task } from "./support/meta-model-fixtures.js";

function imageMessage(id: string, attachments: ImageAttachment[]): ConversationSnapshot["messages"][number] {
	return {
		id,
		direction: "incoming",
		sender: "Alex",
		text: "See this",
		replyTo: null,
		attachments,
		reactions: [],
		unsent: false,
	};
}

const remote = (url: string): ImageAttachment => ({ type: "image", url, description: null, media: null });

const local = (data: string, width: number, height: number): ImageAttachment => ({
	type: "image",
	url: null,
	description: null,
	media: { mime: "image/jpeg", data, width, height },
});

test("the Meta request forwards the newest photos as image blocks without their URLs", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	const bytes = await photo();
	const inline = (await photo(60, 40)).toString("base64");
	const seen: { url: string; init: { redirect?: string; credentials?: string } }[] = [];
	let body: any;
	globalThis.fetch = (async (input: any, init: any) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.meta.ai/v1/chat/completions") {
			body = await new Request(input, init).json();
			return modelResponse();
		}
		seen.push({ url, init: { redirect: init?.redirect, credentials: init?.credentials } });
		if (url === "https://example.test/redirect") {
			return new Response(null, { status: 302, headers: { location: "https://example.test/target" } });
		}
		return new Response(bytes as unknown as BodyInit, { status: 200, headers: { "content-type": "image/jpeg" } });
	}) as typeof fetch;
	try {
		const messages = [
			imageMessage("oldest", [remote("https://example.test/oldest")]),
			imageMessage("middle", [remote("https://example.test/redirect"), local(inline, 60, 40)]),
			imageMessage("newest", [remote("https://example.test/newest")]),
		];
		const result = await new MetaModelAdapter().run(
			task,
			{ ...conversation, messages } as unknown as ConversationSnapshot,
			"new_message",
		);
		assert.deepEqual(result, { action: "wait" });
		const content = body.messages[2].content;
		assert.equal(content[0].type, "text");
		assert.deepEqual(
			content
				.slice(1)
				.map(({ type, image_url }: { type: string; image_url: { detail: string } }) => [type, image_url.detail]),
			[
				["image_url", "auto"],
				["image_url", "auto"],
				["image_url", "auto"],
				["image_url", "auto"],
			],
		);
		for (const block of content.slice(1)) {
			assert.match(block.image_url.url, /^data:image\/jpeg;base64,/);
		}
		// The inline photo passes through untouched.
		assert.equal(content[3].image_url.url, `data:image/jpeg;base64,${inline}`);
		const payload = JSON.parse(content[0].text);
		assert.deepEqual(
			payload.conversation.map((entry: { attachments: unknown[] }) => entry.attachments),
			[
				[{ type: "image", imageIndex: 0 }],
				[
					{ type: "image", imageIndex: 1 },
					{ type: "image", imageIndex: 2 },
				],
				[{ type: "image", imageIndex: 3 }],
			],
		);
		assert.doesNotMatch(JSON.stringify(body), /example\.test/);
		assert.match(body.messages[0].content, /imageIndex/);
		// Redirects stay manual and cookie-free.
		assert.deepEqual(
			seen.map(({ init }) => init),
			seen.map(() => ({ redirect: "manual", credentials: "omit" })),
		);
		assert.deepEqual(seen.map(({ url }) => url).sort(), [
			"https://example.test/newest",
			"https://example.test/oldest",
			"https://example.test/redirect",
			"https://example.test/target",
		]);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});

test("the Meta request keeps photos past the cap and failed fetches presence-only", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	const bytes = await photo();
	let body: any;
	globalThis.fetch = (async (input: any, init: any) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.meta.ai/v1/chat/completions") {
			body = await new Request(input, init).json();
			return modelResponse();
		}
		if (url === "https://example.test/down") throw new Error("socket hang up");
		if (url === "https://example.test/not-image") {
			return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
		}
		if (url === "https://example.test/downgrade") {
			return new Response(null, { status: 302, headers: { location: "http://example.test/plain" } });
		}
		if (url === "https://example.test/huge") {
			return new Response(Buffer.alloc(8_000_001) as unknown as BodyInit, {
				status: 200,
				headers: { "content-type": "image/jpeg" },
			});
		}
		if (url === "https://example.test/animated") {
			const gif = Buffer.from("R0lGODlhAQABAIAAAP///////yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "base64");
			return new Response(gif as unknown as BodyInit, { status: 200, headers: { "content-type": "image/gif" } });
		}
		return new Response(bytes as unknown as BodyInit, { status: 200, headers: { "content-type": "image/jpeg" } });
	}) as typeof fetch;
	try {
		const messages = [
			imageMessage("oldest", [remote("https://example.test/oldest")]),
			imageMessage("newest", [
				remote("https://example.test/down"),
				remote("https://example.test/not-image"),
				remote("https://example.test/downgrade"),
				remote("https://example.test/huge"),
				remote("https://example.test/animated"),
				remote("https://example.test/ok"),
			]),
		];
		const result = await new MetaModelAdapter().run(
			task,
			{ ...conversation, messages } as unknown as ConversationSnapshot,
			"new_message",
		);
		assert.deepEqual(result, { action: "wait" });
		const content = body.messages[2].content;
		// Newest-first selection takes the last four; the GIF and the photo
		// resolve while oversized, downgraded, and failed fetches stay behind.
		assert.equal(content.length, 3);
		assert.equal(content[1].type, "image_url");
		assert.equal(content[2].type, "image_url");
		assert.match(content[1].image_url.url, /^data:image\/gif;base64,/);
		assert.match(content[2].image_url.url, /^data:image\/jpeg;base64,/);
		const payload = JSON.parse(content[0].text);
		assert.deepEqual(payload.conversation[0].attachments, [{ type: "image" }]);
		assert.deepEqual(payload.conversation[1].attachments, [
			{ type: "image" },
			{ type: "image" },
			{ type: "image" },
			{ type: "image" },
			{ type: "image", imageIndex: 0 },
			{ type: "image", imageIndex: 1 },
		]);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});

test("the Meta request downscales fetched photos past the max side", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	const bytes = await photo(2000, 1000);
	let body: any;
	globalThis.fetch = (async (input: any, init: any) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.meta.ai/v1/chat/completions") {
			body = await new Request(input, init).json();
			return modelResponse();
		}
		return new Response(bytes as unknown as BodyInit, { status: 200, headers: { "content-type": "image/jpeg" } });
	}) as typeof fetch;
	try {
		await new MetaModelAdapter().run(
			task,
			{
				...conversation,
				messages: [imageMessage("only", [remote("https://example.test/big")])],
			} as unknown as ConversationSnapshot,
			"new_message",
		);
		const block = body.messages[2].content[1];
		assert.equal(block.type, "image_url");
		const meta = await sharp(Buffer.from(block.image_url.url.split(",")[1], "base64")).metadata();
		assert.equal(meta.width, 1568);
		assert.equal(meta.height, 784);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});

test("the Meta request never fetches or forwards quoted photos", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	const fetched: string[] = [];
	let body: any;
	globalThis.fetch = (async (input: any, init: any) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.meta.ai/v1/chat/completions") {
			body = await new Request(input, init).json();
			return modelResponse();
		}
		fetched.push(url);
		return new Response("no", { status: 404 });
	}) as typeof fetch;
	try {
		const quoted = imageMessage("only", []);
		quoted.replyTo = {
			text: "Original",
			context: "Reply",
			attachments: [remote("https://example.test/quote")],
		};
		await new MetaModelAdapter().run(
			task,
			{ ...conversation, messages: [quoted] } as unknown as ConversationSnapshot,
			"new_message",
		);
		assert.deepEqual(fetched, []);
		assert.equal(typeof body.messages[2].content, "string");
		const payload = JSON.parse(body.messages[2].content);
		assert.deepEqual(payload.conversation[0].replyTo.attachments, [{ type: "image" }]);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});

test("the Meta request forwards GIFs, stickers, and video stills as image blocks", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	const bytes = await photo();
	const frame = (await photo(60, 40)).toString("base64");
	const fetched: string[] = [];
	let body: any;
	globalThis.fetch = (async (input: any, init: any) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.meta.ai/v1/chat/completions") {
			body = await new Request(input, init).json();
			return modelResponse();
		}
		fetched.push(url);
		return new Response(bytes as unknown as BodyInit, { status: 200, headers: { "content-type": "image/jpeg" } });
	}) as typeof fetch;
	try {
		const messages = [
			{
				id: "media",
				direction: "incoming",
				sender: "Alex",
				text: "Look",
				replyTo: null,
				attachments: [
					{ type: "gif", url: "https://example.test/clip", description: null, media: null },
					{ type: "sticker", url: "https://example.test/sticker", description: null, media: null },
					{ type: "video", url: "https://example.test/clip.mp4", description: null, media: null },
					{
						type: "video",
						url: null,
						description: null,
						media: { mime: "image/jpeg", data: frame, width: 60, height: 40 },
					},
					{ type: "file" },
				],
				reactions: [],
				unsent: false,
			},
		];
		await new MetaModelAdapter().run(
			task,
			{ ...conversation, messages } as unknown as ConversationSnapshot,
			"new_message",
		);
		const content = body.messages[2].content;
		// The GIF, the sticker, and the framed video resolve. The bare video
		// URL is attempted but rejected on content type here, and the file
		// stays presence-only.
		assert.deepEqual(fetched.sort(), [
			"https://example.test/clip",
			"https://example.test/clip.mp4",
			"https://example.test/sticker",
		]);
		assert.equal(content.length, 4);
		assert.deepEqual(
			content.slice(1).map(({ type }: { type: string }) => type),
			["image_url", "image_url", "image_url"],
		);
		assert.equal(content[3].image_url.url, `data:image/jpeg;base64,${frame}`);
		const payload = JSON.parse(content[0].text);
		assert.deepEqual(payload.conversation[0].attachments, [
			{ type: "gif", imageIndex: 0 },
			{ type: "sticker", imageIndex: 1 },
			{ type: "video" },
			{ type: "video", imageIndex: 2 },
			{ type: "file" },
		]);
		assert.doesNotMatch(JSON.stringify(body), /example\.test/);
		assert.match(body.messages[0].content, /video stills/);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});

test("the Meta request attempts a video_url block for clip URLs", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	const clipBytes = Buffer.from("fake-mp4-bytes");
	const clipDataUrl = `data:video/mp4;base64,${clipBytes.toString("base64")}`;
	let body: any;
	globalThis.fetch = (async (input: any, init: any) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.meta.ai/v1/chat/completions") {
			body = await new Request(input, init).json();
			return modelResponse();
		}
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
		const content = body.messages[2].content;
		assert.equal(content.length, 2);
		assert.equal(content[1].type, "video_url");
		assert.equal(content[1].video_url.url, clipDataUrl);
		const payload = JSON.parse(content[0].text);
		assert.deepEqual(payload.conversation[0].attachments, [{ type: "video", videoIndex: 0 }]);
		assert.doesNotMatch(JSON.stringify(body), /example\.test\/clip\.mp4/);
		assert.match(body.messages[0].content, /videoIndex/);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});

test("the Meta request re-encodes fetched images past the byte budget as stills", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	const big = await sharp({
		create: { width: 1200, height: 1200, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 30 } },
	})
		.png()
		.toBuffer();
	assert.ok(big.length > 1_000_000);
	let body: any;
	globalThis.fetch = (async (input: any, init: any) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.meta.ai/v1/chat/completions") {
			body = await new Request(input, init).json();
			return modelResponse();
		}
		return new Response(big as unknown as BodyInit, { status: 200, headers: { "content-type": "image/png" } });
	}) as typeof fetch;
	try {
		const messages = [
			{
				id: "big",
				direction: "incoming",
				sender: "Alex",
				text: "Look",
				replyTo: null,
				attachments: [{ type: "image", url: "https://example.test/big", description: null, media: null }],
				reactions: [],
				unsent: false,
			},
		];
		await new MetaModelAdapter().run(
			task,
			{ ...conversation, messages } as unknown as ConversationSnapshot,
			"new_message",
		);
		const content = body.messages[2].content;
		assert.equal(content.length, 2);
		const blockUrl = content[1].image_url.url as string;
		assert.match(blockUrl, /^data:image\/jpeg;base64,/);
		assert.ok(Buffer.from(blockUrl.split(",")[1]!, "base64").length < big.length);
		const payload = JSON.parse(content[0].text);
		assert.deepEqual(payload.conversation[0].attachments, [{ type: "image", imageIndex: 0 }]);
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});

test("the Meta request falls back to presence-only when video blocks are rejected", async () => {
	const previousKey = process.env.MODEL_API_KEY;
	const previousFetch = globalThis.fetch;
	process.env.MODEL_API_KEY = "test-key";
	const clipBytes = Buffer.from("fake-mp4-bytes");
	const bodies: any[] = [];
	globalThis.fetch = (async (input: any, init: any) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.meta.ai/v1/chat/completions") {
			const body = await new Request(input, init).json();
			bodies.push(body);
			if (JSON.stringify(body).includes("video_url")) {
				return new Response(JSON.stringify({ error: { message: "unknown part" } }), { status: 400 });
			}
			return modelResponse('{"action":"reply","text":"Got it"}');
		}
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
		const decision = await new MetaModelAdapter().run(
			task,
			{ ...conversation, messages } as unknown as ConversationSnapshot,
			"new_message",
		);
		assert.equal(bodies.length, 2);
		const retry = bodies[1].messages[2].content;
		assert.equal(typeof retry, "string");
		const payload = JSON.parse(retry);
		assert.deepEqual(payload.conversation[0].attachments, [{ type: "video" }]);
		assert.equal(decision.action, "reply");
	} finally {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.MODEL_API_KEY;
		else process.env.MODEL_API_KEY = previousKey;
	}
});
