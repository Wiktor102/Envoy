import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { messengerChatAdapter } from "../src/messenger/chat-adapter";
import { fixture, setMessages, setup } from "./support/conversation-fixtures";

type StubSize = { width: number; height: number } | "error";

function installImageStub(sizes: Record<string, StubSize>): () => void {
	const previous = (globalThis as Record<string, unknown>).Image;
	(globalThis as Record<string, unknown>).Image = class {
		naturalWidth = 0;
		naturalHeight = 0;
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		set src(value: string) {
			const size = sizes[value] ?? sizes["*"];
			queueMicrotask(() => {
				if (!size || size === "error") this.onerror?.();
				else {
					this.naturalWidth = size.width;
					this.naturalHeight = size.height;
					this.onload?.();
				}
			});
		}
	};
	return () => {
		if (previous === undefined) delete (globalThis as Record<string, unknown>).Image;
		else (globalThis as Record<string, unknown>).Image = previous;
	};
}

function installCanvasStub(dom: JSDOM, dataUrl: string): () => void {
	const prototype = dom.window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
	const previousContext = prototype.getContext;
	const previousDataUrl = prototype.toDataURL;
	prototype.getContext = () => ({ drawImage() {} });
	prototype.toDataURL = () => dataUrl;
	return () => {
		prototype.getContext = previousContext;
		prototype.toDataURL = previousDataUrl;
	};
}

const photoButton = (src: string, alt = "Otwórz zdjęcie") =>
	`<div data-scope="messages_table" data-message-id="photo" aria-roledescription="message"><div role="button" tabindex="-1"><img alt="${alt}" src="${src}"></div></div>`;

test("inlines a video poster frame for local clips", async () => {
	const dom = setup();
	const restoreCanvas = installCanvasStub(dom, `data:image/jpeg;base64,${"V".repeat(64)}`);
	try {
		setMessages(
			`<div data-scope="messages_table" data-message-id="v1" aria-roledescription="wiadomość" aria-label="O 21:35, Alex"><div role="presentation"><div aria-label="Rozwiń okno z filmem" role="button" tabindex="-1"><div><video playsinline src="blob:https://example.test/video"></video><div><div aria-label="Video player" role="group"><div aria-label="Odtwórz film" role="button" tabindex="-1"></div></div></div></div></div></div>`,
		);
		const video = document.querySelector("video")!;
		Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
		Object.defineProperty(video, "videoWidth", { configurable: true, value: 640 });
		Object.defineProperty(video, "videoHeight", { configurable: true, value: 480 });
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(snapshot.messages[0]!.attachments, [
			{
				type: "video",
				url: null,
				description: null,
				media: { mime: "image/jpeg", data: "V".repeat(64), width: 640, height: 480 },
			},
		]);
	} finally {
		restoreCanvas();
	}
});

test("inlines the newest four media across photos, GIFs, stickers, and clips", async () => {
	const dom = setup();
	const restoreImage = installImageStub({ "*": { width: 100, height: 80 } });
	const restoreCanvas = installCanvasStub(dom, `data:image/jpeg;base64,${"V".repeat(64)}`);
	try {
		setMessages(
			photoButton("data:image/jpeg;base64,AAAA") +
				`<div data-scope="messages_table" data-message-id="g1" aria-roledescription="message"><a href="/messenger_media/?attachment_id=1"><img alt="Fish GIF" src="data:image/gif;base64,BBBB"><span>GIPHY</span></a></div>` +
				`<div data-scope="messages_table" data-message-id="s1" aria-roledescription="message"><div role="button" tabindex="-1"><img alt="Open photo" src="data:image/png;base64,CCCC"></div></div>` +
				`<div data-scope="messages_table" data-message-id="v1" aria-roledescription="wiadomość"><div role="presentation"><div aria-label="Rozwiń okno z filmem" role="button" tabindex="-1"><div><video playsinline src="blob:https://example.test/video"></video><div><div aria-label="Video player" role="group"><div aria-label="Odtwórz film" role="button" tabindex="-1"></div></div></div></div></div></div>` +
				photoButton("data:image/jpeg;base64,EEEE"),
		);
		const video = document.querySelector("video")!;
		Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
		Object.defineProperty(video, "videoWidth", { configurable: true, value: 640 });
		Object.defineProperty(video, "videoHeight", { configurable: true, value: 480 });
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(
			snapshot.messages.map(
				(message) =>
					(message.attachments[0] as { type: string; media: { data: string } | null }).media?.data ?? null,
			),
			// Five local renders, one shared cap: the oldest photo keeps its
			// type but loses the inline race.
			[null, "BBBB", "CCCC", "V".repeat(64), "EEEE"],
		);
		assert.deepEqual(
			snapshot.messages.map((message) => (message.attachments[0] as { type: string }).type),
			["image", "gif", "image", "video", "image"],
		);
	} finally {
		restoreImage();
		restoreCanvas();
	}
});

test("inlines local photo bytes for encrypted photo buttons", async () => {
	const dom = setup();
	const restoreImage = installImageStub({ "*": { width: 800, height: 600 } });
	try {
		setMessages(
			photoButton("data:image/jpeg;base64,AAAA") +
				`<div data-scope="messages_table" data-message-id="two" aria-roledescription="message"><div role="button" tabindex="-1"><img alt="Open photo" src="data:image/png;base64,BBBB"></div><div role="button" tabindex="-1"><img alt="Open image" src="data:image/webp;base64,CCCC"></div></div>`,
		);
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(
			snapshot.messages.map((message) => message.attachments),
			[
				[
					{
						type: "image",
						url: null,
						description: null,
						media: { mime: "image/jpeg", data: "AAAA", width: 800, height: 600 },
					},
				],
				[
					{
						type: "image",
						url: null,
						description: null,
						media: { mime: "image/png", data: "BBBB", width: 800, height: 600 },
					},
					{
						type: "image",
						url: null,
						description: null,
						media: { mime: "image/webp", data: "CCCC", width: 800, height: 600 },
					},
				],
			],
		);
		assert.ok(JSON.stringify(snapshot).includes("AAAA"));
	} finally {
		restoreImage();
	}
});

test("downscales local photos past the max side to JPEG", async () => {
	const dom = setup();
	const restoreImage = installImageStub({ "*": { width: 2000, height: 1000 } });
	const restoreCanvas = installCanvasStub(dom, `data:image/jpeg;base64,${"Q".repeat(64)}`);
	try {
		setMessages(photoButton("data:image/png;base64,AAAA"));
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(snapshot.messages[0]!.attachments, [
			{
				type: "image",
				url: null,
				description: null,
				media: { mime: "image/jpeg", data: "Q".repeat(64), width: 1568, height: 784 },
			},
		]);
	} finally {
		restoreImage();
		restoreCanvas();
	}
});

test("downscales large sources into the byte cap instead of dropping them", async () => {
	const dom = setup();
	const big = `data:image/jpeg;base64,${"A".repeat(1_200_004)}`;
	const wide = `data:image/png;base64,${"B".repeat(1_200_004)}`;
	const restoreImage = installImageStub({ [big]: { width: 2048, height: 1365 }, [wide]: { width: 800, height: 600 } });
	const restoreCanvas = installCanvasStub(dom, `data:image/jpeg;base64,${"Q".repeat(64)}`);
	try {
		setMessages(photoButton(big) + photoButton(wide));
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(
			snapshot.messages.map((message) => message.attachments),
			[
				[
					{
						type: "image",
						url: null,
						description: null,
						media: { mime: "image/jpeg", data: "Q".repeat(64), width: 1568, height: 1045 },
					},
				],
				[
					{
						type: "image",
						url: null,
						description: null,
						media: { mime: "image/jpeg", data: "Q".repeat(64), width: 800, height: 600 },
					},
				],
			],
		);
	} finally {
		restoreImage();
		restoreCanvas();
	}
});

test("keeps local photos presence-only when their bytes cannot be used", async () => {
	const dom = setup();
	const restoreImage = installImageStub({ "*": { width: 100, height: 80 } });
	try {
		for (const src of [
			`data:image/jpeg;base64,${"A".repeat(12_000_004)}`,
			"data:image/jpeg;base64,!!!",
			"data:image/jpeg;base64,AAAAA",
			"data:image/svg+xml;base64,AAAA",
			"blob:https://www.messenger.com/photo",
		]) {
			setMessages(photoButton(src));
			const snapshot = await messengerChatAdapter.readConversation();
			assert.deepEqual(snapshot.messages[0]!.attachments, [
				{ type: "image", url: null, description: null, media: null },
			]);
		}
	} finally {
		restoreImage();
	}
	const failing = setup();
	const restoreFailing = installImageStub({ "*": "error" });
	try {
		setMessages(photoButton("data:image/jpeg;base64,AAAA"));
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(snapshot.messages[0]!.attachments, [{ type: "image", url: null, description: null, media: null }]);
	} finally {
		restoreFailing();
	}
	const unloaded = setup();
	try {
		// Without image decoding the reader stays fail-closed, not broken.
		setMessages(photoButton("data:image/jpeg;base64,AAAA"));
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(snapshot.messages[0]!.attachments, [{ type: "image", url: null, description: null, media: null }]);
	} finally {
	}
});

test("inlines only the newest four photos when more render", async () => {
	const dom = setup();
	const restoreImage = installImageStub({ "*": { width: 100, height: 80 } });
	try {
		setMessages(
			["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"].map((data) => photoButton(`data:image/jpeg;base64,${data}`)).join(""),
		);
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(
			snapshot.messages.map(
				(message) =>
					(message.attachments[0] as { type: string; media: { data: string } | null }).media?.data ?? null,
			),
			[null, "BBBB", "CCCC", "DDDD", "EEEE"],
		);
	} finally {
		restoreImage();
	}
});

test("keeps quoted photos type-only while inlining message photos", async () => {
	const dom = setup();
	const restoreImage = installImageStub({ "*": { width: 100, height: 80 } });
	try {
		setMessages(
			photoButton("data:image/jpeg;base64,AAAA") +
				`<div data-scope="messages_table"><h4>You replied to Alex</h4><div role="button" aria-label="Przejdź do wiadomości, na którą odpowiadasz"><img alt="Zdjęcie" src="data:image/jpeg;base64,BBBB"></div><span dir="auto">Nice photo</span></div>`,
		);
		const snapshot = await messengerChatAdapter.readConversation();
		assert.equal((snapshot.messages[0]!.attachments[0] as { media: { data: string } | null }).media?.data, "AAAA");
		assert.deepEqual(snapshot.messages[1]!.replyTo, {
			text: null,
			context: "You replied to Alex",
			attachments: [{ type: "image", url: null, description: null, media: null }],
		});
	} finally {
		restoreImage();
	}
});

test("prefers the GIF render in multi-image links regardless of order", async () => {
	const dom = setup();
	try {
		const cat = (id: string) =>
			`<div data-scope="messages_table" data-message-id="${id}" aria-roledescription="wiadomość" aria-label="O 21:29, Alex"><a href="/messenger_media/?attachment_id=1"><img alt="" src="https://example.test/static"><img alt="Cat Fall GIF cat, fall" src="https://example.test/cat"></a></div>`;
		const reversed = (id: string) =>
			`<div data-scope="messages_table" data-message-id="${id}" aria-roledescription="wiadomość" aria-label="O 21:29, Alex"><a href="/messenger_media/?attachment_id=1"><img alt="Cat Fall GIF cat, fall" src="https://example.test/cat"><img alt="" src="https://example.test/static"></a></div>`;
		for (const fixture of [cat("g1"), reversed("g1")]) {
			setMessages(fixture);
			const snapshot = await messengerChatAdapter.readConversation();
			assert.deepEqual(snapshot.messages[0]!.attachments, [
				{ type: "gif", url: "https://example.test/cat", description: null, media: null },
			]);
		}
		// Swapping the animated render invalidates even when the static one stays.
		setMessages(cat("g1"));
		const before = await messengerChatAdapter.readConversation();
		setMessages(cat("g1").replace("https://example.test/cat", "https://example.test/other-cat"));
		assert.notEqual((await messengerChatAdapter.readConversation()).revision, before.revision);
	} finally {
	}
});

test("reads GIPHY-captioned links with tag-like alts as GIFs regardless of order", async () => {
	const dom = setup();
	try {
		// Live normal chat: the kiwi render carries tag text with no GIF word,
		// beside an empty-alt static image and a GIPHY caption.
		const kiwi = (id: string) =>
			`<div data-scope="messages_table" data-message-id="${id}" aria-roledescription="wiadomość" aria-label="O 21:29, Alex"><a href="/messenger_media/?attachment_id=1"><img alt="green, vegan, fruit, spiral, kiwi" src="https://example.test/kiwi"><img alt="" src="https://example.test/static"><span>GIPHY</span></a></div>`;
		const reversed = (id: string) =>
			`<div data-scope="messages_table" data-message-id="${id}" aria-roledescription="wiadomość" aria-label="O 21:29, Alex"><a href="/messenger_media/?attachment_id=1"><img alt="" src="https://example.test/static"><img alt="green, vegan, fruit, spiral, kiwi" src="https://example.test/kiwi"><span>GIPHY</span></a></div>`;
		for (const fixture of [kiwi("g1"), reversed("g1")]) {
			setMessages(fixture);
			const snapshot = await messengerChatAdapter.readConversation();
			assert.deepEqual(snapshot.messages[0]!.attachments, [
				{ type: "gif", url: "https://example.test/kiwi", description: null, media: null },
			]);
		}
		// Without the caption the same link stays a photo: the chrome carries
		// the classification, not the tag text alone.
		setMessages(kiwi("g1").replace("<span>GIPHY</span>", ""));
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(snapshot.messages[0]!.attachments, [
			{ type: "image", url: "https://example.test/kiwi", description: null, media: null },
		]);
	} finally {
	}
});

test("inlines local GIF renders while keeping remote GIF links fetchable", async () => {
	const dom = setup();
	const restoreImage = installImageStub({ "*": { width: 100, height: 80 } });
	try {
		setMessages(
			`<div data-scope="messages_table" data-message-id="g1" aria-roledescription="message"><a href="/messenger_media/?attachment_id=1"><img alt="Fish GIF" src="data:image/gif;base64,AAAA"><span>GIPHY</span></a></div>` +
				`<div data-scope="messages_table" data-message-id="g2" aria-roledescription="message"><a href="/messenger_media/?attachment_id=2"><img alt="Cat GIF" src="https://example.test/animated"><span>GIPHY</span></a></div>`,
		);
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(snapshot.messages[0]!.attachments, [
			{
				type: "gif",
				url: null,
				description: null,
				media: { mime: "image/gif", data: "AAAA", width: 100, height: 80 },
			},
		]);
		assert.deepEqual(snapshot.messages[1]!.attachments, [
			{ type: "gif", url: "https://example.test/animated", description: null, media: null },
		]);
	} finally {
		restoreImage();
	}
});

test("keeps the revision independent of inline bytes", async () => {
	const dom = setup();
	try {
		setMessages(photoButton("data:image/jpeg;base64,AAAA"));
		const withoutBytes = await messengerChatAdapter.readConversation();
		assert.equal((withoutBytes.messages[0]!.attachments[0] as { media: unknown }).media, null);
		const restoreImage = installImageStub({ "*": { width: 100, height: 80 } });
		try {
			setMessages(photoButton("data:image/jpeg;base64,AAAA"));
			const withBytes = await messengerChatAdapter.readConversation();
			assert.equal((withBytes.messages[0]!.attachments[0] as { media: { data: string } | null }).media?.data, "AAAA");
			assert.equal(withBytes.revision, withoutBytes.revision);
		} finally {
			restoreImage();
		}
	} finally {
	}
});
