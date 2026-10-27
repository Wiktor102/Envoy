import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { bindMessengerDocument, ConversationUnavailableError, messengerChatAdapter } from "../src/messenger/chat-adapter";
import { watchConversation } from "../src/ui/conversation";

function setup(path = "/t/123") {
	const dom = new JSDOM('<main role="main"></main>', { url: `https://www.messenger.com${path}` });
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		location: dom.window.location,
		MutationObserver: dom.window.MutationObserver,
	});
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	// jsdom has no layout engine; elements in these fixtures are rendered.
	dom.window.HTMLElement.prototype.getClientRects = () => [1] as unknown as DOMRectList;
	const main = dom.window.document.querySelector<HTMLElement>("main")!;
	main.style.overflowY = "auto";
	Object.defineProperty(main, "clientHeight", { configurable: true, value: 400 });
	Object.defineProperty(main, "scrollHeight", { configurable: true, value: 400 });
	bindMessengerDocument();
	return dom;
}

function setMessages(html: string) {
	document.querySelector("main")!.innerHTML = html;
}

const fixture = `
	<div data-scope="messages_table">
		<div role="row"><div dir="auto">Hello <span dir="auto">there</span></div></div>
		<div role="row"><div dir="auto">&lt;script&gt;alert(1)&lt;/script&gt;</div></div>
		<button><span dir="auto">Reply</span></button>
		<div aria-hidden="true"><span dir="auto">Hidden</span></div>
	</div>`;

test("ignores date separator scopes but rejects unrecognized content beside them", async () => {
	const dom = setup();
	setMessages(
		`<div data-scope="messages_table"><div aria-hidden="true" data-scope="date_break"><span dir="auto">Monday</span></div></div>${fixture}`,
	);
	assert.equal((await messengerChatAdapter.readConversation()).messages.length, 2);
	document
		.querySelector('[data-scope="date_break"]')!
		.parentElement!.append(document.createTextNode("unreadable content"));
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
	);
	dom.window.close();
});

test("ignores Messenger date scopes before, between, and after messages", async () => {
	const dom = setup();
	const date =
		'<div data-scope="messages_table"><div role="presentation"><div data-scope="date_break" aria-hidden="true"><span dir="auto">Pon, 15:16</span></div></div></div>';
	setMessages(
		`${date}<div data-scope="messages_table"><span dir="auto">Hello</span></div>${date}<div data-scope="messages_table"><span dir="auto">Hi</span></div>${date}`,
	);
	assert.deepEqual(
		(await messengerChatAdapter.readConversation()).messages.map(({ text }) => text),
		["Hello", "Hi"],
	);
	for (const extra of [
		"<span>Unmapped message</span>",
		"<video></video>",
		'<div role="button" aria-label="Play"></div>',
	]) {
		setMessages(`${fixture}${date.replace("</div></div></div>", `</div>${extra}</div></div>`)}`);
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
	dom.window.close();
});

test("reads loaded text in order, without nested duplicates or controls", async () => {
	const dom = setup();
	setMessages(fixture);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.equal(snapshot.chatId, "123");
	assert.deepEqual(
		snapshot.messages.map((message) => message.text),
		["Hello there", "<script>alert(1)</script>"],
	);
	const reread = await messengerChatAdapter.readConversation();
	assert.deepEqual(reread, snapshot);
	(document.querySelector('[dir="auto"]') as HTMLElement).firstChild!.textContent = "Hi ";
	const changed = await messengerChatAdapter.readConversation();
	assert.equal(changed.messages[0]!.id, snapshot.messages[0]!.id);
	assert.notEqual(changed.revision, snapshot.revision);
	dom.window.close();
});

test("reads inline emoji in text and quoted replies and changes the revision with their alt text", async () => {
	const dom = setup();
	setMessages(`
		<div data-scope="messages_table">
			<div role="row" data-message-direction="incoming"><span dir="auto">Sounds good <img alt="👍🏽"> <img alt="🇵🇱"> <img alt="1️⃣"></span></div>
			<div role="row" data-message-direction="incoming">
				<div role="button" aria-label="View original message"><span dir="auto">Quoted <img alt="❤️"></span></div>
				<span dir="auto"><img alt="👨‍👩‍👧‍👦"></span>
			</div>
		</div>`);
	const original = await messengerChatAdapter.readConversation();
	assert.equal(original.messages[0]!.text, "Sounds good 👍🏽 🇵🇱 1️⃣");
	assert.equal(original.messages[1]!.text, "👨‍👩‍👧‍👦");
	assert.equal(original.messages[1]!.replyTo?.text, "Quoted ❤️");
	document.querySelector("img")!.setAttribute("alt", "👎");
	const changed = await messengerChatAdapter.readConversation();
	assert.equal(changed.messages[0]!.text, "Sounds good 👎 🇵🇱 1️⃣");
	assert.notEqual(changed.revision, original.revision);
	dom.window.close();
});

test("rejects inline media whose alternative text is not exclusively emoji", async () => {
	const dom = setup();
	for (const media of ['<img alt="photo 1">', '<img alt="😀2">', '<img alt="">', "<svg></svg>"]) {
		setMessages(`<div data-scope="messages_table"><div role="row"><span dir="auto">Hello ${media}</span></div></div>`);
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
	dom.window.close();
});

test("rejects a snapshot if an inline emoji changes while its revision is hashing", async () => {
	const dom = setup();
	setMessages('<div data-scope="messages_table"><div role="row"><span dir="auto">Okay <img alt="👍"></span></div></div>');
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
	document.querySelector("img")!.setAttribute("alt", "👎");
	resolveDigest(new ArrayBuffer(32));
	await assert.rejects(
		pending,
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "changed",
	);
	dom.window.close();
});

test("keeps the revision when identical content is rendered with new DOM nodes", async () => {
	const firstDom = setup();
	setMessages(fixture);
	const original = await messengerChatAdapter.readConversation();
	setMessages(fixture);
	const remounted = await messengerChatAdapter.readConversation();
	assert.notDeepEqual(
		remounted.messages.map(({ id }) => id),
		original.messages.map(({ id }) => id),
	);
	assert.equal(remounted.revision, original.revision);
	firstDom.window.close();

	const reloadedDom = setup();
	setMessages(fixture);
	const reloaded = await messengerChatAdapter.readConversation();
	assert.notDeepEqual(
		reloaded.messages.map(({ id }) => id),
		original.messages.map(({ id }) => id),
	);
	assert.equal(reloaded.revision, original.revision);
	reloadedDom.window.close();
});

test("revision reflects chat, message order, and repeated messages", async () => {
	const dom = setup();
	setMessages(
		'<div data-scope="messages_table"><div role="row"><span dir="auto">A</span></div><div role="row"><span dir="auto">B</span></div></div>',
	);
	const original = await messengerChatAdapter.readConversation();
	setMessages(
		'<div data-scope="messages_table"><div role="row"><span dir="auto">B</span></div><div role="row"><span dir="auto">A</span></div></div>',
	);
	assert.notEqual((await messengerChatAdapter.readConversation()).revision, original.revision);
	setMessages(
		'<div data-scope="messages_table"><div role="row"><span dir="auto">A</span></div><div role="row"><span dir="auto">B</span></div><div role="row"><span dir="auto">B</span></div></div>',
	);
	assert.notEqual((await messengerChatAdapter.readConversation()).revision, original.revision);
	dom.window.history.pushState({}, "", "/t/456");
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "navigated",
	);
	dom.window.close();
});

test("uses only explicit sender metadata and includes direction in the revision", async () => {
	const dom = setup();
	setMessages(`
		<div data-scope="messages_table">
			<div role="row" aria-label="Received from Alex"><span dir="auto">Hello</span></div>
			<div role="row" aria-label="You sent"><span dir="auto">Hi</span></div>
			<div role="row"><span dir="auto">You sent</span></div>
			<div role="row" data-message-direction="outgoing" aria-label="Received from Alex"><span dir="auto">Conflicting</span></div>
		</div>`);
	const first = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		first.messages.map(({ direction }) => direction),
		["incoming", "outgoing", "unknown", "unknown"],
	);
	document.querySelector('[aria-label="Received from Alex"]')!.setAttribute("aria-label", "You sent");
	const changed = await messengerChatAdapter.readConversation();
	assert.equal(changed.messages[0]!.direction, "outgoing");
	assert.notEqual(changed.revision, first.revision);
	dom.window.close();
});

test("reads per-message Polish and English sender labels in direct and group chats", async () => {
	for (const path of ["/e2ee/t/123", "/messages/e2ee/t/123", "/t/123"]) {
		const dom = setup(path);
		const labels = [
			"O poniedziałek 15:28, Alex: Hello",
			"O 09:46, Sam: Hi",
			"O 09:46, Sam: Again",
			"O 13:04, Ty: Hello",
			"At Monday 9:46 AM, You: Hi",
			"At 9:46 PM, Alex",
			"Not a sender label",
		];
		setMessages(
			labels
				.map(
					(label, i) =>
						`<div data-scope="messages_table" data-message-id="message-${i}" aria-roledescription="wiadomość" aria-label="${label}"><span dir="auto">Text</span></div>`,
				)
				.join(""),
		);
		assert.deepEqual(
			(await messengerChatAdapter.readConversation()).messages.map(({ direction }) => direction),
			["incoming", "incoming", "incoming", "outgoing", "outgoing", "incoming", "unknown"],
		);
		const first = document.querySelector("[data-message-id]")!;
		first.setAttribute("data-message-direction", "outgoing");
		assert.equal((await messengerChatAdapter.readConversation()).messages[0]!.direction, "unknown");
		first.removeAttribute("data-message-direction");
		first.removeAttribute("aria-roledescription");
		assert.equal((await messengerChatAdapter.readConversation()).messages[0]!.direction, "unknown");
		dom.window.close();
	}
});

test("requires a reload after navigation, even when the message DOM changes", async () => {
	const dom = setup();
	setMessages(fixture);
	await messengerChatAdapter.readConversation();
	dom.window.history.pushState({}, "", "/t/456");
	await assert.rejects(messengerChatAdapter.readConversation(), ConversationUnavailableError);
	setMessages(fixture);
	await assert.rejects(messengerChatAdapter.readConversation(), ConversationUnavailableError);
	setMessages('<div data-scope="messages_table"><div dir="auto">New thread</div></div>');
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "navigated",
	);
	dom.window.close();
	const reloaded = setup("/t/456");
	setMessages('<div data-scope="messages_table"><div dir="auto">New thread</div></div>');
	assert.equal((await messengerChatAdapter.readConversation()).chatId, "456");
	reloaded.window.close();
});

test("binds before the first read and remains blocked after navigating back", async () => {
	const dom = setup();
	setMessages(fixture);
	dom.window.history.pushState({}, "", "/t/456");
	dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
	dom.window.history.pushState({}, "", "/t/123");
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "navigated",
	);
	dom.window.close();
});

// Structure based on the rendered Facebook Messenger message scopes; all content is synthetic.
const replyAndReactionFixture = `
	<div role="article"><div data-scope="messages_table">
		<div><h4 dir="auto">You replied to Alex</h4></div>
		<div><div role="button" aria-label="Przejdź do wiadomości, na którą odpowiadasz">
			<span>Oryginalna wiadomość: </span><span dir="auto">Original text</span>
		</div></div>
		<div><span dir="auto"><div dir="auto">My answer</div></span></div>
	</div></div>
	<div role="article"><div data-scope="messages_table">
		<div><span dir="auto"><div dir="auto">Another message</div></span></div>
		<div role="button" aria-label="1 reakcja z 😆; zobacz, kto na to zareagował."><img alt="😆"></div>
		<div role="toolbar"><div role="button" aria-label="Add reaction"><img alt="👍"></div></div>
	</div></div>`;

test("associates quoted replies and reaction summaries with their messages", async () => {
	const dom = setup();
	setMessages(replyAndReactionFixture);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map(({ text, replyTo, reactions }) => ({ text, replyTo, reactions })),
		[
			{
				text: "My answer",
				replyTo: { text: "Original text", context: "You replied to Alex", attachments: [] },
				reactions: [],
			},
			{
				text: "Another message",
				replyTo: null,
				reactions: [{ label: "1 reakcja z 😆; zobacz, kto na to zareagował.", emojis: ["😆"], count: 1 }],
			},
		],
	);
	const reaction = document.querySelector('[aria-label^="1 reakcja"]')!;
	reaction.setAttribute("aria-label", "2 reakcje z 😆; zobacz, kto na to zareagował.");
	const changed = await messengerChatAdapter.readConversation();
	assert.equal(changed.messages[1]!.reactions[0]!.count, 2);
	assert.notEqual(changed.revision, snapshot.revision);
	dom.window.close();
});

test("changes the revision when a quoted reply changes", async () => {
	const dom = setup();
	setMessages(replyAndReactionFixture);
	const original = await messengerChatAdapter.readConversation();
	document.querySelector('[role="button"][aria-label*="odpowiadasz"] [dir="auto"]')!.textContent = "Different quote";
	const changed = await messengerChatAdapter.readConversation();
	assert.notEqual(changed.revision, original.revision);
	dom.window.close();
});

test("does not attach metadata from a boundary shared by multiple messages", async () => {
	const dom = setup();
	setMessages(`
		<div data-scope="messages_table"><span dir="auto">First</span><span dir="auto">Second</span>
			<button aria-label="1 reaction">👍</button>
		</div>`);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map((message) => message.reactions),
		[[], []],
	);
	dom.window.close();
});

test("rejects a snapshot when reaction metadata changes while hashing", async () => {
	const dom = setup();
	setMessages(replyAndReactionFixture);
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
	document.querySelector('[aria-label^="1 reakcja"]')!.setAttribute("aria-label", "2 reakcje");
	resolveDigest(new ArrayBuffer(32));
	await assert.rejects(
		pending,
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "changed",
	);
	dom.window.close();
});

const photoFixture = `
	<div role="article"><div data-scope="messages_table">
		<a href="/messenger_media/?attachment_id=1"><img alt="" src="https://example.test/one"></a>
	</div></div>
	<div role="article"><div data-scope="messages_table">
		<span dir="auto">A caption</span>
		<a href="https://www.facebook.com/messenger_media/?attachment_id=2"><img alt="" src="https://example.test/two"></a>
		<a href="https://www.facebook.com/messenger_media/?attachment_id=3"><img alt="" src="https://example.test/three"></a>
		<div role="button" aria-label="1 reakcja"><img alt="😆"></div>
	</div></div>
	<div role="article"><div data-scope="messages_table">
		<h4 dir="auto">You replied to Alex</h4>
		<div role="button" aria-label="Przejdź do wiadomości, na którą odpowiadasz"><img alt="Zdjęcie" src="https://example.test/preview"></div>
		<span dir="auto">Nice photo</span>
	</div></div>
	<div role="article"><div data-scope="messages_table">
		<span dir="auto">Just text</span><img alt="avatar" src="https://example.test/avatar">
		<a href="https://example.test/messenger_media/?attachment_id=4">external</a>
	</div></div>`;

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
		dom.window.close();
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
	dom.window.close();
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
	dom.window.close();
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
	dom.window.close();
});

test("reads image URLs for image-only, mixed, and quoted messages", async () => {
	const dom = setup();
	setMessages(photoFixture);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map((message) => ({ text: message.text, attachments: message.attachments })),
		[
			{ text: "", attachments: [{ type: "image", url: "https://example.test/one", description: null }] },
			{
				text: "A caption",
				attachments: [
					{ type: "image", url: "https://example.test/two", description: null },
					{ type: "image", url: "https://example.test/three", description: null },
				],
			},
			{ text: "Nice photo", attachments: [] },
			{ text: "Just text", attachments: [] },
		],
	);
	assert.deepEqual(snapshot.messages[2]!.replyTo, {
		text: null,
		context: "You replied to Alex",
		attachments: [{ type: "image", url: "https://example.test/preview", description: null }],
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
	dom.window.close();
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
	dom.window.close();
});

test("prefers the browser-selected image source", async () => {
	const dom = setup();
	setMessages(photoFixture);
	const image = document.querySelector<HTMLImageElement>('a[href*="attachment_id=1"] img')!;
	Object.defineProperty(image, "currentSrc", { configurable: true, value: "https://example.test/selected.jpg" });
	const snapshot = await messengerChatAdapter.readConversation();
	assert.equal(snapshot.messages[0]!.attachments[0]!.url, "https://example.test/selected.jpg");
	dom.window.close();
});

test("does not misidentify inline emoji or unlabeled icons in reply previews", async () => {
	const dom = setup();
	setMessages(`<div data-scope="messages_table"><h4>Reply</h4>
		<div role="button" aria-label="Przejdź do wiadomości, na którą odpowiadasz">
			<span dir="auto">hello <img alt="😆"></span><img alt="avatar">
		</div><span dir="auto">Answer</span></div>`);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(snapshot.messages[0]!.replyTo?.attachments, []);
	dom.window.close();
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
	dom.window.close();
});

test("fails closed without a thread or an identifiable message table", async () => {
	const dom = setup();
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "not-ready",
	);
	dom.window.close();
	const noThread = setup("/");
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "no-chat",
	);
	noThread.window.close();
});

test("requires a measurable message scroll area at its bottom", async () => {
	const dom = setup();
	setMessages(fixture);
	const main = document.querySelector<HTMLElement>("main")!;
	main.style.overflowY = "visible";
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "not-latest",
	);
	main.style.overflowY = "auto";
	Object.defineProperty(main, "scrollHeight", { configurable: true, value: 1000 });
	main.scrollTop = 0;
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "not-latest",
	);
	main.scrollTop = 600;
	assert.equal((await messengerChatAdapter.readConversation()).messages.length, 2);
	dom.window.close();
});

test("rejects an unrecognized row after readable incoming text", async () => {
	const dom = setup();
	setMessages(`
		<div data-scope="messages_table">
			<div role="row" data-message-direction="incoming"><span dir="auto">Hello</span></div>
			<div role="row"><div role="button" aria-label="Play"></div></div>
		</div>`);
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
	);
	setMessages(`
		<div role="grid">
			<div role="row"><div data-scope="messages_table"><span dir="auto">Hello</span></div></div>
			<div role="row"><div role="button" aria-label="Play"></div></div>
		</div>`);
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
	);
	dom.window.close();
});

test("rejects text messages containing unsupported media", async () => {
	const dom = setup();
	for (const media of ["<video></video>", '<span role="img" aria-label="Sticker"></span>']) {
		setMessages(`<div data-scope="messages_table"><div role="row"><span dir="auto">Caption</span>${media}</div></div>`);
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
	dom.window.close();
});

test("rejects a snapshot when the message table changes while hashing", async () => {
	const dom = setup();
	setMessages(fixture);
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
	setMessages('<div data-scope="messages_table"><div dir="auto">New message</div></div>');
	resolveDigest(new ArrayBuffer(32));
	await assert.rejects(
		pending,
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "changed",
	);
	dom.window.close();
});

test("updates the watched snapshot when only a reaction label changes", async () => {
	const dom = setup();
	setMessages(replyAndReactionFixture);
	const counts: Array<number | null> = [];
	const stop = watchConversation((snapshot) => {
		const reaction = snapshot?.messages[1]?.reactions[0];
		if (reaction) counts.push(reaction.count);
	});
	const waitFor = async (predicate: () => boolean) => {
		for (let i = 0; i < 40 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
		assert.ok(predicate(), "Timed out waiting for reaction update");
	};
	try {
		await waitFor(() => counts.includes(1));
		document.querySelector('[aria-label^="1 reakcja"]')!.setAttribute("aria-label", "2 reakcje");
		await waitFor(() => counts.includes(2));
	} finally {
		stop();
		dom.window.close();
	}
});

test("updates the watched revision when an image link changes", async () => {
	const dom = setup();
	setMessages(photoFixture);
	const revisions: string[] = [];
	const stop = watchConversation((snapshot) => {
		if (snapshot) revisions.push(snapshot.revision);
	});
	const waitFor = async (predicate: () => boolean) => {
		for (let i = 0; i < 40 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
		assert.ok(predicate(), "Timed out waiting for image update");
	};
	try {
		await waitFor(() => revisions.length > 0);
		const first = revisions[0];
		document
			.querySelector('a[href*="attachment_id=1"]')!
			.setAttribute("href", "/messenger_media/?attachment_id=changed");
		await waitFor(() => revisions.some((revision) => revision !== first));
	} finally {
		stop();
		dom.window.close();
	}
});

test("clears the old chat and asks for a reload after navigation", async () => {
	const dom = setup();
	setMessages(fixture);
	const updates: Array<{ chatId: string | null; status: string }> = [];
	const stop = watchConversation((snapshot, status) => updates.push({ chatId: snapshot?.chatId ?? null, status }));
	const waitFor = async (predicate: () => boolean) => {
		for (let i = 0; i < 40 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
		assert.ok(predicate(), "Timed out waiting for conversation update");
	};
	try {
		await waitFor(() => updates.some((update) => update.chatId === "123"));
		dom.window.history.pushState({}, "", "/t/456");
		dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
		await waitFor(() => updates.at(-1)?.status === "Loading the selected conversation...");
		// Messenger can remount the old chat while the URL already names the next one.
		setMessages(fixture);
		await waitFor(() => updates.at(-1)?.status === "The selected chat changed. Reload this tab to use Envoy in it.");
		assert.equal(
			updates.some((update) => update.chatId === "456"),
			false,
		);
		setMessages('<div data-scope="messages_table"><div dir="auto">Other chat</div></div>');
		await new Promise((resolve) => setTimeout(resolve, 450));
		assert.equal(
			updates.some((update) => update.chatId === "456"),
			false,
		);
		assert.equal(updates.at(-1)?.status, "The selected chat changed. Reload this tab to use Envoy in it.");
	} finally {
		stop();
		dom.window.close();
	}
});

test("reads group events as system context and omits the group introduction", async () => {
	const dom = setup();
	const intro = `<div data-scope="messages_table" data-release-focus-from="CLICK" tabindex="0">
		<div role="img" aria-label="Group"><img alt="Person"></div><h3 dir="auto"><span dir="auto">Group</span></h3>
		<div><span dir="auto">Person created group</span></div><ul><li><div role="button" tabindex="-1" aria-label="Add"><svg></svg></div><span dir="auto">Add</span></li><li><div role="button" tabindex="-1" aria-label="Name"></div><span dir="auto">Name</span></li></ul></div>`;
	const event = `<div data-scope="messages_table" data-release-focus-from="CLICK" tabindex="0"><div role="presentation"><div><div role="presentation"><div role="presentation"><span dir="auto"><div role="presentation">Person renamed group</div></span></div></div></div></div></div>`;
	setMessages(
		`${intro}<div data-scope="messages_table" data-message-id="1" aria-roledescription="message" aria-label="At 17:50, Alex: Hello"><span dir="auto">Hello</span></div>${event}<div data-scope="messages_table"><span dir="auto">Unidentified</span></div>`,
	);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map(({ text, direction }) => [text, direction]),
		[
			["Hello", "incoming"],
			["Person renamed group", "system"],
			["Unidentified", "unknown"],
		],
	);
	for (const scope of document.querySelectorAll('[tabindex="0"]')) scope.setAttribute("tabindex", "-1");
	assert.deepEqual((await messengerChatAdapter.readConversation()).messages, snapshot.messages);
	document.querySelectorAll('[role="presentation"] span[dir="auto"] div')[0]!.textContent = "Another event";
	assert.notEqual((await messengerChatAdapter.readConversation()).revision, snapshot.revision);
	dom.window.close();
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
			["", [{ type: "image", url: null, description: null }]],
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
	dom.window.close();
});

test("reads unsent placeholders as unsent messages without placeholder text", async () => {
	const dom = setup();
	for (const placeholder of [
		'<div><span dir="auto">Alex cofnął wysłanie wiadomości</span></div>',
		"<div><div>Alex unsent a message</div></div>",
		"<div><span>You unsent a message</span></div>",
	]) {
		setMessages(`
			<div data-scope="messages_table" data-message-id="text" aria-roledescription="message" aria-label="At 19:03, Alex: Hi"><span dir="auto">Hi</span></div>
			<div data-scope="messages_table" data-message-id="unsent" aria-roledescription="wiadomość" aria-label="O 19:05, Alex">${placeholder}</div>`);
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(
			snapshot.messages.map(({ text, direction, unsent }) => ({ text, direction, unsent })),
			[
				{ text: "Hi", direction: "incoming", unsent: false },
				{ text: "", direction: "incoming", unsent: true },
			],
		);
	}
	dom.window.close();
});

test("changes the revision when a message is unsent", async () => {
	const dom = setup();
	setMessages('<div data-scope="messages_table"><div role="row"><span dir="auto">Can we meet at 5?</span></div></div>');
	const original = await messengerChatAdapter.readConversation();
	document.querySelector('[dir="auto"]')!.textContent = "Alex unsent a message";
	const changed = await messengerChatAdapter.readConversation();
	assert.equal(changed.messages[0]!.unsent, true);
	assert.notEqual(changed.revision, original.revision);
	dom.window.close();
});

test("does not read a quote of an unavailable message as quoted text", async () => {
	const dom = setup();
	for (const quote of ["Wiadomość niedostępna", "Original message was deleted", "Alex unsent a message"]) {
		setMessages(`<div data-scope="messages_table" data-message-id="reply">
			<h4>Alex replied to you</h4>
			<div role="button" aria-label="View original message"><span dir="auto">${quote}</span></div>
			<span dir="auto">ok</span>
		</div>`);
		const [message] = (await messengerChatAdapter.readConversation()).messages;
		assert.equal(message!.text, "ok");
		assert.equal(message!.unsent, false);
		assert.equal(message!.replyTo?.text, null);
	}
	dom.window.close();
});
