import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { ConversationUnavailableError, messengerChatAdapter } from "../src/messenger/chat-adapter";
import { photoFixture, setMessages, setup } from "./support/conversation-fixtures";

test("reads encrypted photo buttons in direct and group conversations", async () => {
	for (const path of ["/messages/e2ee/t/123", "/e2ee/t/123", "/t/123"]) {
		const dom = setup(path);
		setMessages(`
			<div data-scope="messages_table" data-message-id="photo" aria-roledescription="wiadomość" aria-label="O piątek 18:53, Alex">
				<h4 dir="auto">Alex</h4>
				<div role="button" tabindex="-1"><div><img alt="Otwórz zdjęcie" src="https://example.test/photo"></div><svg aria-hidden="true"></svg></div>
				<div role="button" aria-label="1 reakcja z ❤️"><img alt="❤️"></div>
			</div>
			<div data-scope="messages_table" data-message-id="caption" aria-roledescription="message" aria-label="At 19:03, You: A caption">
				<span dir="auto">A caption</span>
				<button><img alt="Open photo" src="https://example.test/two"></button>
				<div role="button"><img alt="Open image" src="https://example.test/three"></div>
			</div>
			<div data-scope="messages_table" data-message-id="text" aria-roledescription="wiadomość" aria-label="O 19:04, Alex: Thanks"><span dir="auto">Thanks</span><img alt="avatar"></div>`);
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(
			snapshot.messages.map(({ text, direction, attachments }) => ({
				text,
				direction,
				urls: attachments.map(({ url }) => url),
			})),
			[
				{ text: "", direction: "incoming", urls: ["https://example.test/photo"] },
				{
					text: "A caption",
					direction: "outgoing",
					urls: ["https://example.test/two", "https://example.test/three"],
				},
				{ text: "Thanks", direction: "incoming", urls: [] },
			],
		);
		assert.equal(snapshot.messages[0]!.reactions[0]!.count, 1);
		document.querySelector('img[alt="Otwórz zdjęcie"]')!.setAttribute("src", "https://example.test/changed");
		assert.notEqual((await messengerChatAdapter.readConversation()).revision, snapshot.revision);
	}
});

test("does not mistake photo previews, toolbar images, or arbitrary buttons for attachments", async () => {
	const dom = setup();
	setMessages(`<div data-scope="messages_table" data-message-id="reply">
		<h4>You replied to Alex</h4>
		<div role="button" aria-label="View original message"><img alt="Open photo" src="https://example.test/quote"></div>
		<span dir="auto">Thanks</span>
		<div role="toolbar"><button><img alt="Open photo"></button></div>
	</div>`);
	assert.equal((await messengerChatAdapter.readConversation()).messages[0]!.attachments.length, 0);
	for (const photo of [
		'<div role="button"><img alt="avatar"></div>',
		'<div role="button"><img alt="Sticker"></div>',
		'<img alt="Open photo">',
	]) {
		setMessages(`<div data-scope="messages_table" data-message-id="photo">${photo}</div>`);
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
});

test("invalidates encrypted photos when a data source changes without a public URL", async () => {
	const dom = setup();
	setMessages(
		'<div data-scope="messages_table" data-message-id="photo"><div role="button"><img alt="Otwórz zdjęcie" src="data:image/png;base64,AAAA"></div></div>',
	);
	const original = await messengerChatAdapter.readConversation();
	assert.equal(original.messages[0]!.attachments[0]!.url, null);
	document.querySelector("img")!.setAttribute("src", "data:image/png;base64,BBBB");
	const changed = await messengerChatAdapter.readConversation();
	assert.equal(changed.messages[0]!.attachments[0]!.url, null);
	assert.notEqual(changed.revision, original.revision);
	assert.ok(!JSON.stringify(changed).includes("base64"));
});

test("keeps image revisions stable when the same messages are remounted", async () => {
	const dom = setup();
	setMessages(photoFixture);
	const original = await messengerChatAdapter.readConversation();
	setMessages(photoFixture);
	const remounted = await messengerChatAdapter.readConversation();
	assert.notDeepEqual(
		remounted.messages.map(({ id }) => id),
		original.messages.map(({ id }) => id),
	);
	assert.equal(remounted.revision, original.revision);
});

test("reads image URLs for image-only, mixed, and quoted messages", async () => {
	const dom = setup();
	setMessages(photoFixture);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map((message) => ({ text: message.text, attachments: message.attachments })),
		[
			{ text: "", attachments: [{ type: "image", url: "https://example.test/one", description: null, media: null }] },
			{
				text: "A caption",
				attachments: [
					{ type: "image", url: "https://example.test/two", description: null, media: null },
					{ type: "image", url: "https://example.test/three", description: null, media: null },
				],
			},
			{ text: "Nice photo", attachments: [] },
			{ text: "Just text", attachments: [] },
		],
	);
	assert.deepEqual(snapshot.messages[2]!.replyTo, {
		text: null,
		context: "You replied to Alex",
		attachments: [{ type: "image", url: "https://example.test/preview", description: null, media: null }],
	});
	assert.equal(snapshot.messages[1]!.reactions.length, 1);
	assert.ok(!JSON.stringify(snapshot).includes("attachment_id"));
	const reread = await messengerChatAdapter.readConversation();
	assert.deepEqual(reread, snapshot);
	const image = document.querySelector<HTMLAnchorElement>('a[href*="attachment_id=1"]')!;
	image.setAttribute("href", "/messenger_media/?attachment_id=changed");
	const changed = await messengerChatAdapter.readConversation();
	assert.notEqual(changed.revision, snapshot.revision);
	assert.equal(changed.messages[0]!.id, snapshot.messages[0]!.id);
});

test("handles unloaded, relative, and non-web image sources", async () => {
	const dom = setup();
	setMessages(`
		<div data-scope="messages_table"><a href="/messenger_media/?attachment_id=1"><img></a></div>
		<div data-scope="messages_table"><a href="/messenger_media/?attachment_id=2"><img src="/photos/example.jpg"></a></div>
		<div data-scope="messages_table"><a href="/messenger_media/?attachment_id=3"><img src="data:image/png;base64,AAAA"></a></div>`);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map((message) => message.attachments[0]!.url),
		[null, "https://www.messenger.com/photos/example.jpg", null],
	);
	const image = document.querySelector<HTMLImageElement>('a[href*="attachment_id=1"] img')!;
	image.setAttribute("src", "https://example.test/loaded.jpg");
	const changed = await messengerChatAdapter.readConversation();
	assert.equal(changed.messages[0]!.attachments[0]!.url, "https://example.test/loaded.jpg");
	assert.notEqual(changed.revision, snapshot.revision);
});

test("prefers the browser-selected image source", async () => {
	const dom = setup();
	setMessages(photoFixture);
	const image = document.querySelector<HTMLImageElement>('a[href*="attachment_id=1"] img')!;
	Object.defineProperty(image, "currentSrc", { configurable: true, value: "https://example.test/selected.jpg" });
	const snapshot = await messengerChatAdapter.readConversation();
	assert.equal(snapshot.messages[0]!.attachments[0]!.url, "https://example.test/selected.jpg");
});

test("does not misidentify inline emoji or unlabeled icons in reply previews", async () => {
	const dom = setup();
	setMessages(`<div data-scope="messages_table"><h4>Reply</h4>
		<div role="button" aria-label="Przejdź do wiadomości, na którą odpowiadasz">
			<span dir="auto">hello <img alt="😆"></span><img alt="avatar">
		</div><span dir="auto">Answer</span></div>`);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(snapshot.messages[0]!.replyTo?.attachments, []);
});

test("rejects a snapshot if an image link changes while hashing", async () => {
	const dom = setup();
	setMessages(photoFixture);
	let resolveDigest!: (digest: ArrayBuffer) => void;
	Object.defineProperty(globalThis, "crypto", {
		configurable: true,
		value: {
			randomUUID: webcrypto.randomUUID.bind(webcrypto),
			subtle: {
				digest: () =>
					new Promise<ArrayBuffer>((resolve) => {
						resolveDigest = resolve;
					}),
			},
		},
	});
	const pending = messengerChatAdapter.readConversation();
	document.querySelector('a[href*="attachment_id=1"]')!.setAttribute("href", "/messenger_media/?attachment_id=changed");
	resolveDigest(new ArrayBuffer(32));
	await assert.rejects(
		pending,
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "changed",
	);
});

test("reads an animated preview as an unreadable attachment and tracks its blob source", async () => {
	const dom = setup();
	const path =
		"M13.126 9.949c1.5-.866 1.5-3.031 0-3.897l-6.75-3.898C4.875 1.288 3 2.371 3 4.103v7.794c0 1.732 1.875 2.815 3.375 1.949l6.75-3.897z";
	const preview = `<div role="button" tabindex="0" aria-label="Otwórz GIF "><div><img alt="" src="blob:https://www.facebook.com/first"><div role="button" tabindex="0" aria-label="Dotknij, aby odtworzyć GIF "><svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"></path></svg></div></div></div>`;
	const wrap = (content: string) =>
		`<div data-scope="messages_table" data-message-id="1" aria-roledescription="message" aria-label="At 17:50, Alex">${content}</div><div data-scope="messages_table" data-message-id="2" aria-roledescription="message" aria-label="At 17:51, Alex: Hello"><span dir="auto">Hello</span></div>`;
	setMessages(wrap(preview));
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map(({ text, attachments }) => [text, attachments]),
		[
			["", [{ type: "gif", url: null, description: null, media: null }]],
			["Hello", []],
		],
	);
	document.querySelector("img")!.setAttribute("src", "blob:https://www.facebook.com/second");
	assert.notEqual((await messengerChatAdapter.readConversation()).revision, snapshot.revision);
	for (const button of document.querySelectorAll('[role="button"]')) button.setAttribute("tabindex", "-1");
	assert.equal((await messengerChatAdapter.readConversation()).messages[0]!.attachments.length, 1);
	for (const unsafe of [
		preview.replace(path, "M0 0"),
		preview.replace("blob:https://www.facebook.com/first", "https://example.com/a"),
		preview.replace("</div></div></div>", "<video></video></div></div></div>"),
		'<img alt="" src="blob:https://www.facebook.com/x">',
	]) {
		setMessages(wrap(unsafe));
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
});

test("reads the observed GIPHY image link while rejecting ambiguous media", async () => {
	const dom = setup();
	const gif = `<div data-scope="messages_table" data-message-id="g1" aria-roledescription="wiadomość" aria-label="O 21:29, Alex"><a href="/messenger_media/?attachment_id=1"><img alt="Fish GIF fish, hello there" src="https://example.test/gif"><span>GIPHY</span></a></div>`;
	// Live normal chat: an uploaded GIF renders as the same link with a
	// descriptive alt and no GIPHY caption.
	const uploaded = `<div data-scope="messages_table" data-message-id="g2" aria-roledescription="wiadomość" aria-label="O 21:29, Alex"><a href="/messenger_media/?attachment_id=2"><img alt="Obraz GIF" src="https://example.test/uploaded"></a></div>`;
	const sticker = `<div data-scope="messages_table" data-message-id="s1" aria-roledescription="wiadomość" aria-label="O 21:30, Alex"><div role="img" aria-label="Banana sticker" style="background-image: url(https://example.test/sticker)"></div></div>`;
	const text = `<div data-scope="messages_table" data-message-id="t1" aria-roledescription="wiadomość" aria-label="O 21:31, Alex: Hello"><span dir="auto">Hello</span></div>`;
	setMessages(`${gif}${uploaded}${sticker}${text}`);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map(({ text, attachments }) => [text, attachments.map(({ type }) => type)]),
		[
			["", ["gif"]],
			["", ["gif"]],
			["", ["sticker"]],
			["Hello", []],
		],
	);
	assert.equal(snapshot.messages[1]!.attachments[0]!.url, "https://example.test/uploaded");
	for (const unsafe of [
		gif.replace("/messenger_media/?attachment_id=1", "https://example.test/other"),
		gif.replace("</a>", "<video></video></a>"),
	]) {
		setMessages(unsafe);
		await assert.rejects(messengerChatAdapter.readConversation(), ConversationUnavailableError);
	}
});

test("reads encrypted GIF buttons as presence-only without blocking the chat", async () => {
	const dom = setup();
	setMessages(
		`<div data-scope="messages_table" data-message-id="g1" aria-roledescription="message" aria-label="At 17:50, Alex"><div role="button" aria-label="Otwórz GIF"><img alt="Evening sky GIF" src="blob:https://www.messenger.com/first"></div></div>` +
			`<div data-scope="messages_table" data-message-id="g2" aria-roledescription="wiadomość"><div role="button" tabindex="0"><img alt="Funny GIF" src="data:image/gif;base64,AAAA"></div></div>` +
			`<div data-scope="messages_table" data-message-id="t1" aria-roledescription="message" aria-label="At 17:51, Alex: Hello"><span dir="auto">Hello</span></div>`,
	);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map(({ text, attachments }) => [text, attachments]),
		[
			["", [{ type: "gif", url: null, description: null, media: null }]],
			["", [{ type: "gif", url: null, description: null, media: null }]],
			["Hello", []],
		],
	);
	document.querySelector("img")!.setAttribute("src", "blob:https://www.messenger.com/second");
	assert.notEqual((await messengerChatAdapter.readConversation()).revision, snapshot.revision);
	for (const unsafe of [
		// Two images in one button.
		`<div data-scope="messages_table" data-message-id="g1" aria-roledescription="message"><div role="button"><img alt="First GIF" src="blob:https://example.test/1"><img alt="Second GIF" src="blob:https://example.test/2"></div></div>`,
		// No message boundary.
		`<div data-scope="messages_table"><div role="button"><img alt="Stray GIF" src="blob:https://example.test/3"></div></div>`,
	]) {
		setMessages(unsafe);
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
});

test("reads quoted GIFs as type-only without blocking the chat", async () => {
	const dom = setup();
	setMessages(
		`<div data-scope="messages_table"><h4>You replied to Alex</h4><div role="button" aria-label="View original message"><div role="button" aria-label="Open GIF"><img alt="Funny GIF" src="blob:https://www.messenger.com/q"></div></div><span dir="auto">Nice one</span></div>` +
			`<div data-scope="messages_table"><h4>You replied to Sam</h4><div role="button" aria-label="Przejdź do wiadomości, na którą odpowiadasz"><img alt="Fish GIF" src="https://example.test/gif"><img alt="Zdjęcie" src="https://example.test/photo"></div><span dir="auto">Haha</span></div>`,
	);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map((message) => message.replyTo),
		[
			{
				text: null,
				context: "You replied to Alex",
				attachments: [{ type: "gif", url: null, description: null, media: null }],
			},
			{
				text: null,
				context: "You replied to Sam",
				attachments: [
					{ type: "gif", url: null, description: null, media: null },
					{ type: "image", url: "https://example.test/photo", description: null, media: null },
				],
			},
		],
	);
	assert.deepEqual(
		snapshot.messages.map((message) => message.attachments),
		[[], []],
	);
	document.querySelector("img")!.setAttribute("src", "blob:https://www.messenger.com/changed");
	assert.notEqual((await messengerChatAdapter.readConversation()).revision, snapshot.revision);
	for (const unsafe of [
		// Other media words inside a quote still trip.
		`<div data-scope="messages_table"><h4>You replied to Alex</h4><div role="button" aria-label="View original message"><img alt="Voice message" src="blob:https://example.test/v"></div><span dir="auto">Hmm</span></div>`,
		`<div data-scope="messages_table"><h4>You replied to Alex</h4><div role="button" aria-label="View original message"><div role="button" aria-label="Open video"><img alt="Clip GIF" src="blob:https://example.test/c"></div></div><span dir="auto">Hmm</span></div>`,
	]) {
		setMessages(unsafe);
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
});

test("reads a recognized video as unavailable media without blocking later text", async () => {
	const dom = setup();
	// Observed signed-in rendering (redacted): a standalone clip is a real
	// <video> inside an expand button with Video player UI. A caption typed
	// with the clip and a later follow-up each arrive as separate text scopes.
	const videoMessage = `<div data-scope="messages_table" data-message-id="v1" aria-roledescription="wiadomość" aria-label="O 21:35, Wiktor testowy"><div role="presentation"><div aria-label="Rozwiń okno z filmem" role="button" tabindex="-1"><div><video playsinline src="blob:https://example.test/video"></video><div><div aria-label="Video player" role="group"><div aria-label="Odtwórz film" role="button" tabindex="-1"></div><div>0:02</div></div></div></div></div></div></div>`;
	const remoteVideo = `<div data-scope="messages_table" data-message-id="v2" aria-roledescription="wiadomość" aria-label="O 21:35, Wiktor testowy"><div role="presentation"><div aria-label="Rozwiń okno z filmem" role="button" tabindex="-1"><div><video playsinline src="https://example.test/clip.mp4"></video><div><div aria-label="Video player" role="group"><div aria-label="Odtwórz film" role="button" tabindex="-1"></div><div>0:02</div></div></div></div></div></div></div>`;
	const followup = `<div data-scope="messages_table" data-message-id="t1" aria-roledescription="wiadomość" aria-label="O 21:36, Wiktor testowy: Video follow-up test"><span><div><div dir="auto">Video follow-up test</div></div></span></div>`;
	// jsdom never loads video data; report unloaded dimensions so the frame
	// capture stays presence-only without waiting out its load timeout.
	const stallVideos = () => {
		for (const video of document.querySelectorAll("video")) {
			Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
			Object.defineProperty(video, "videoWidth", { configurable: true, value: 0 });
			Object.defineProperty(video, "videoHeight", { configurable: true, value: 0 });
		}
	};
	setMessages(`${videoMessage}${remoteVideo}${followup}`);
	stallVideos();
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map(({ text, direction, attachments }) => ({ text, direction, attachments })),
		[
			{ text: "", direction: "incoming", attachments: [{ type: "video", url: null, description: null, media: null }] },
			{
				text: "",
				direction: "incoming",
				attachments: [{ type: "video", url: "https://example.test/clip.mp4", description: null, media: null }],
			},
			{ text: "Video follow-up test", direction: "incoming", attachments: [] },
		],
	);
	// A latest video stays readable but carries an attachment, so the task
	// layer can pause or ask instead of treating it as text.
	setMessages(videoMessage);
	stallVideos();
	const latest = await messengerChatAdapter.readConversation();
	assert.equal(latest.messages.length, 1);
	assert.deepEqual(latest.messages[0]!.attachments, [{ type: "video", url: null, description: null, media: null }]);
});

test("reads recognized stickers as unavailable media without blocking later text", async () => {
	const dom = setup();
	// Observed signed-in rendering (redacted): each sticker is a bare div
	// with role="img", a label ending in "sticker", and a CSS background
	// image. Avatar, toolbar, and sender headings are not the sticker.
	const incomingSticker = `<div data-scope="messages_table" data-message-id="s1" aria-roledescription="wiadomość" aria-label="O 21:29, Alex"><h4 dir="auto"><span dir="auto">Alex</span></h4><div aria-hidden="true"><img alt="Alex"></div><div><div role="img" tabindex="-1" aria-label="Animated banana with googly eyes, bouncing happily. sticker" style="background-image: url(blob:https://example.test/banana); height: 96px; width: 96px;"></div></div><div role="toolbar"><div role="presentation"></div></div></div>`;
	const outgoingSticker = `<div data-scope="messages_table" data-message-id="s2" aria-roledescription="wiadomość" aria-label="O 22:33, Ty"><div><div role="img" tabindex="-1" aria-label="Mollusk waving a pearl with one hand sticker" style="background-image: url(blob:https://example.test/mollusk); height: 96px; width: 96px;"></div></div></div>`;
	const remoteSticker = `<div data-scope="messages_table" data-message-id="s3" aria-roledescription="wiadomość" aria-label="O 22:33, Alex"><div><div role="img" tabindex="-1" aria-label="Cat in a hat sticker" style="background-image: url(https://example.test/cat); height: 96px; width: 96px;"></div></div></div>`;
	const followup = `<div data-scope="messages_table" data-message-id="t1" aria-roledescription="wiadomość" aria-label="O 22:34, Alex: Sounds good"><span><div><div dir="auto">Sounds good</div></div></span></div>`;
	setMessages(`${incomingSticker}${outgoingSticker}${remoteSticker}${followup}`);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map(({ text, direction, attachments }) => ({ text, direction, attachments })),
		[
			{
				text: "",
				direction: "incoming",
				attachments: [{ type: "sticker", url: null, description: null, media: null }],
			},
			{
				text: "",
				direction: "outgoing",
				attachments: [{ type: "sticker", url: null, description: null, media: null }],
			},
			{
				text: "",
				direction: "incoming",
				attachments: [{ type: "sticker", url: "https://example.test/cat", description: null, media: null }],
			},
			{ text: "Sounds good", direction: "incoming", attachments: [] },
		],
	);
	// A CSS URL can rotate across reloads, so only the sticker label feeds
	// the revision. A replaced sticker still invalidates pending sends.
	document
		.querySelector('[role="img"]')!
		.setAttribute("style", "background-image: url(blob:https://example.test/rotated);");
	assert.equal((await messengerChatAdapter.readConversation()).revision, snapshot.revision);
	document.querySelector('[role="img"]')!.setAttribute("aria-label", "Mollusk waving a pearl with one hand sticker");
	assert.notEqual((await messengerChatAdapter.readConversation()).revision, snapshot.revision);
	// A latest sticker stays readable but carries an attachment.
	setMessages(incomingSticker);
	const latest = await messengerChatAdapter.readConversation();
	assert.equal(latest.messages.length, 1);
	assert.deepEqual(latest.messages[0]!.attachments, [{ type: "sticker", url: null, description: null, media: null }]);
});

test("keeps sticker detection narrow and fail-closed", async () => {
	const dom = setup();
	const sticker = `<div role="img" tabindex="-1" aria-label="Animated banana with googly eyes, bouncing happily. sticker" style="background-image: url(blob:https://example.test/banana);"></div>`;
	// The word "sticker" in message text is not a sticker attachment.
	setMessages(
		`<div data-scope="messages_table" data-message-id="t1" aria-roledescription="wiadomość" aria-label="O 21:30, Alex: Send a sticker tomorrow"><span><div><div dir="auto">Send a sticker tomorrow</div></div></span></div>` +
			`<div data-scope="messages_table" data-message-id="s1" aria-roledescription="wiadomość" aria-label="O 21:29, Alex"><div>${sticker}</div></div>`,
	);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map(({ text, attachments }) => ({ text, attachments })),
		[
			{ text: "Send a sticker tomorrow", attachments: [] },
			{ text: "", attachments: [{ type: "sticker", url: null, description: null, media: null }] },
		],
	);
	for (const scope of [
		// Sticker label without a CSS background image.
		`<div data-scope="messages_table" data-message-id="s1" aria-roledescription="wiadomość" aria-label="O 21:29, Alex"><div><div role="img" tabindex="-1" aria-label="Animated banana sticker"></div></div></div>`,
		// Background image without a sticker label.
		`<div data-scope="messages_table" data-message-id="s1" aria-roledescription="wiadomość" aria-label="O 21:29, Alex"><div><div role="img" tabindex="-1" aria-label="Animated banana" style="background-image: url(blob:https://example.test/banana);"></div></div></div>`,
		// A recognized sticker beside unrecognized bare media.
		`<div data-scope="messages_table" data-message-id="s1" aria-roledescription="wiadomość" aria-label="O 21:29, Alex"><div>${sticker}</div></div><div data-scope="messages_table"><span dir="auto"><video></video></span></div>`,
		// A quoted sticker stays out of message attachments and fails closed.
		`<div data-scope="messages_table" data-message-id="q1" aria-roledescription="wiadomość" aria-label="O 21:31, Alex: Thanks"><div role="button" aria-label="Przejdź do wiadomości, na którą odpowiadasz"><div>${sticker}</div></div><span><div><div dir="auto">Thanks</div></div></span></div>`,
	]) {
		setMessages(scope);
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
});

test("reads file rows as presence-only without failing the snapshot", async () => {
	const dom = setup();
	const blobFile = `<div data-scope="messages_table" data-message-id="f1" aria-roledescription="wiadomość" aria-label="O 21:40, Alex"><div><a download="notes.txt" href="blob:https://example.test/notes"><span dir="auto">notes.txt</span><span dir="auto">34 B</span></a></div></div>`;
	const remoteFile = `<div data-scope="messages_table" data-message-id="f2" aria-roledescription="wiadomość" aria-label="O 21:41, Alex"><div><a download="deck.pdf" href="https://example.test/deck"><span dir="auto">deck.pdf</span></a></div></div>`;
	const followup = `<div data-scope="messages_table" data-message-id="t1" aria-roledescription="wiadomość" aria-label="O 21:42, Alex: See attached"><span><div><div dir="auto">See attached</div></div></span></div>`;
	setMessages(`${blobFile}${remoteFile}${followup}`);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map(({ text, attachments }) => ({ text, attachments })),
		[
			{ text: "", attachments: [{ type: "file" }] },
			{ text: "", attachments: [{ type: "file" }] },
			{ text: "See attached", attachments: [] },
		],
	);
	// The href never leaves the extension, but a replaced row invalidates.
	assert.ok(!JSON.stringify(snapshot).includes("example.test"));
	document.querySelector("a[download]")!.setAttribute("href", "blob:https://example.test/changed");
	assert.notEqual((await messengerChatAdapter.readConversation()).revision, snapshot.revision);
	// A latest file stays readable but carries an attachment for the pause.
	setMessages(blobFile);
	const latest = await messengerChatAdapter.readConversation();
	assert.deepEqual(latest.messages[0]!.attachments, [{ type: "file" }]);
});

test("keeps file detection narrow and fail-closed", async () => {
	const dom = setup();
	// A quoted download row never qualifies as an attachment; the quote
	// stays text so the reader keeps working.
	setMessages(
		`<div data-scope="messages_table" data-message-id="q1" aria-roledescription="wiadomość" aria-label="O 21:31, Alex: Thanks"><div role="button" aria-label="Przejdź do wiadomości, na którą odpowiadasz"><a download="x" href="blob:https://example.test/x">x</a></div><span><div><div dir="auto">Thanks</div></div></span></div>`,
	);
	const quoted = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		quoted.messages.map((message) => message.attachments),
		[[]],
	);
	assert.equal(quoted.messages[0]!.text, "Thanks");
	for (const scope of [
		// Toolbar, hidden, and boundary-less download rows never qualify.
		`<div data-scope="messages_table" data-message-id="f1" aria-roledescription="wiadomość"><div role="toolbar"><a download="x" href="blob:https://example.test/x">x</a></div></div>`,
		`<div data-scope="messages_table" data-message-id="f1" aria-roledescription="wiadomość"><div aria-hidden="true"><a download="x" href="blob:https://example.test/x">x</a></div></div>`,
		`<div data-scope="messages_table"><a download="x" href="blob:https://example.test/x">x</a></div>`,
		// A recognized file beside unrecognized bare media.
		`<div data-scope="messages_table" data-message-id="f1" aria-roledescription="wiadomość"><a download="x" href="blob:https://example.test/x">x</a></div><div data-scope="messages_table"><span dir="auto"><video></video></span></div>`,
	]) {
		setMessages(scope);
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
});

test("reads quoted video, sticker, GIF, and file previews as type-only", async () => {
	const dom = setup();
	setMessages(
		`<div data-scope="messages_table" data-message-id="q1" aria-roledescription="wiadomość"><h4>You replied to Alex</h4><div role="button" aria-label="View original message"><img alt="" src="https://example.test/thumb"></div><span dir="auto">That clip</span></div>` +
			`<div data-scope="messages_table" data-message-id="q2" aria-roledescription="wiadomość"><h4>You replied to Sam</h4><div role="button" aria-label="Przejdź do wiadomości, na którą odpowiadasz"><img alt="Dancing banana" src="https://example.test/sticker"></div><span dir="auto">Cute</span></div>` +
			`<div data-scope="messages_table" data-message-id="q3" aria-roledescription="wiadomość"><h4>You replied to Alex</h4><div role="button" aria-label="View original message"><a role="link" aria-disabled="true" aria-label="Otwórz GIF"><img alt="" src="blob:https://example.test/g1"><img alt="" src="https://example.test/g2"></a><span>GIPHY</span></div><span dir="auto">Funny</span></div>` +
			`<div data-scope="messages_table" data-message-id="q4" aria-roledescription="wiadomość"><h4>You replied to Alex</h4><div role="button" aria-label="View original message"><span dir="auto">Oryginalna wiadomość: Załącznik</span></div><span dir="auto">Got it</span></div>`,
	);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map((message) => message.replyTo),
		[
			{
				text: null,
				context: "You replied to Alex",
				attachments: [{ type: "video", url: "https://example.test/thumb", description: null, media: null }],
			},
			{
				text: null,
				context: "You replied to Sam",
				attachments: [{ type: "sticker", url: "https://example.test/sticker", description: null, media: null }],
			},
			{
				text: null,
				context: "You replied to Alex",
				attachments: [
					{ type: "gif", url: null, description: null, media: null },
					{ type: "gif", url: "https://example.test/g2", description: null, media: null },
				],
			},
			{ text: "Oryginalna wiadomość: Załącznik", context: "You replied to Alex", attachments: [] },
		],
	);
	assert.deepEqual(
		snapshot.messages.map((message) => message.attachments),
		[[], [], [], []],
	);
});
