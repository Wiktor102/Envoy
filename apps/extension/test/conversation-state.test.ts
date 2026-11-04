import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { ConversationUnavailableError, messengerChatAdapter } from "../src/messenger/chat-adapter";
import { watchConversation } from "../src/ui/conversation";
import { fixture, photoFixture, replyAndReactionFixture, setMessages, setup } from "./support/conversation-fixtures";

// Observed visible typing bubble: a live announcement plus an aria-hidden
// visual subtree with the sender avatar and animated dots. Synthetic text.
const typingAvatar = `<svg aria-label="Wiktor testowy" role="img"><mask><circle></circle></mask><g><image></image><circle></circle></g></svg>`;

const typingBubbleFor = (list: string) => `<div data-scope="messages_table"><div role="presentation">
	<div aria-live="polite"><div>Wiktor testowy pisze</div></div>
	<div aria-hidden="true">
		<div role="presentation"><div role="list">${list}</div></div>
		<div role="presentation"><div><div><div></div><div></div><div></div></div></div></div>
	</div>
</div></div>`;

// Live reload structure: an empty spacer plus a wrapped avatar svg.
const typingBubble = typingBubbleFor(`<div></div><div role="listitem"><div>${typingAvatar}</div></div>`);

const typingBubbleDirect = typingBubbleFor(`<div role="listitem">${typingAvatar}</div>`);

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
	const reloaded = setup("/t/456");
	setMessages('<div data-scope="messages_table"><div dir="auto">New thread</div></div>');
	assert.equal((await messengerChatAdapter.readConversation()).chatId, "456");
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
});

test("fails closed without a thread or an identifiable message table", async () => {
	const dom = setup();
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "not-ready",
	);
	const noThread = setup("/");
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "no-chat",
	);
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
});

test("omits the 1-1 encrypted introduction notice in English and Polish", async () => {
	const dom = setup();
	// Stripped to tags, roles, and attributes: a bare avatar img, an h3 name,
	// and the notice text with a "Learn more" button (not a link). The matcher
	// ignores wording, so the notice text here is representative, not exact.
	const intro = (name: string, notice: string, more: string) =>
		`<div data-scope="messages_table" data-release-focus-from="CLICK" tabindex="0">` +
		`<div><img alt="${name}"></div><h3 dir="auto"><span dir="auto">${name}</span></h3>` +
		`<div><span dir="auto">${notice}</span><div role="button" tabindex="0"><span>${more}</span></div></div></div>`;
	const message = `<div data-scope="messages_table" data-message-id="1" aria-roledescription="message" aria-label="At 17:50, Alex: Hello"><span dir="auto">Hello</span></div>`;
	for (const [name, notice, more] of [
		["Alex", "Messages and calls are secured with end-to-end encryption.", "Learn more"],
		["Alex", "Wiadomości i połączenia są szyfrowane.", "Dowiedz się więcej"],
	]) {
		setMessages(`${intro(name, notice, more)}${message}`);
		assert.deepEqual(
			(await messengerChatAdapter.readConversation()).messages.map(({ text, direction }) => [text, direction]),
			[["Hello", "incoming"]],
		);
	}
});

test("keeps h4 messages and h3 scopes with message metadata or media", async () => {
	const dom = setup();
	// Real messages use h4, not h3, and carry message metadata.
	const h4Message = `<div data-scope="messages_table" data-message-id="1" aria-roledescription="message" aria-label="At 11:12, Alex: Hello"><h4 dir="auto">Alex</h4><span dir="auto">Hello <img alt="👍"></span></div>`;
	const h3Message = `<div data-scope="messages_table" data-message-id="2" aria-roledescription="message" aria-label="At 11:13, Alex: Update"><h3 dir="auto">Alex</h3><img alt="Alex"><span dir="auto">Update</span><div role="button" tabindex="0"><span>More</span></div></div>`;
	setMessages(`${h4Message}${h3Message}`);
	assert.deepEqual(
		(await messengerChatAdapter.readConversation()).messages.map(({ text, direction }) => [text, direction]),
		[
			["Hello 👍", "incoming"],
			["Update", "incoming"],
		],
	);
	// An intro-shaped scope with media is not silently dropped.
	const mediaIntro = `<div data-scope="messages_table" data-release-focus-from="CLICK" tabindex="0"><div><img alt="Alex"></div><h3 dir="auto"><span dir="auto">Alex</span></h3><div><span dir="auto">Notice</span><div role="button" tabindex="0"><span>More</span></div></div><video></video></div>`;
	setMessages(`${mediaIntro}${h4Message}`);
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
	);
});

test("ignores typing-status announcements without changing messages or revision", async () => {
	const dom = setup();
	const base =
		'<div data-scope="messages_table" data-message-id="1" aria-roledescription="message" aria-label="At 11:12, Alex: Hello"><span dir="auto">Hello</span></div>';
	setMessages(base);
	const before = await messengerChatAdapter.readConversation();
	const content = (messages: typeof before.messages) =>
		messages.map(({ text, direction, replyTo, attachments, reactions, unsent }) => ({
			text,
			direction,
			replyTo,
			attachments,
			reactions,
			unsent,
		}));
	// Observed live structure: a one-pixel scope with an aria-live announcement,
	// no message ID or role description. Synthetic announcement text.
	for (const typing of [
		'<div data-scope="messages_table"><div><span aria-live="polite">Wiktor testowy pisze</span></div></div>',
		'<div data-scope="messages_table"><span aria-live="polite"><span dir="auto">Wiktor testowy pisze</span></span></div>',
		'<div data-scope="messages_table" aria-live="polite">Wiktor testowy pisze</div>',
		'<div data-scope="messages_table"><span aria-live="polite"></span></div>',
	]) {
		setMessages(base + typing);
		const withTyping = await messengerChatAdapter.readConversation();
		assert.deepEqual(content(withTyping.messages), content(before.messages));
		assert.equal(withTyping.revision, before.revision);
		const live = document.querySelector("[aria-live]");
		if (live?.textContent?.trim()) {
			live.textContent = "Someone else is typing";
			const changed = await messengerChatAdapter.readConversation();
			assert.deepEqual(content(changed.messages), content(before.messages));
			assert.equal(changed.revision, before.revision);
		}
		setMessages(base);
		const recovered = await messengerChatAdapter.readConversation();
		assert.deepEqual(content(recovered.messages), content(before.messages));
		assert.equal(recovered.revision, before.revision);
	}
});

test("does not hide message metadata or unsupported content in a typing-like scope", async () => {
	const dom = setup();
	const base = '<div data-scope="messages_table"><div role="row"><span dir="auto">Hello</span></div></div>';
	const wrap = (inner: string) =>
		`${base}<div data-scope="messages_table"><span aria-live="polite">Wiktor testowy pisze</span>${inner}</div>`;
	for (const extra of [
		'<div data-message-id="1"></div>',
		'<div aria-roledescription="message"></div>',
		'<div data-message-direction="incoming"></div>',
		'<div data-message-type="voice"></div>',
		'<div data-attachment-type="file"></div>',
		'<div aria-label="Voice message"></div>',
		"<video></video>",
		'<img alt="photo">',
		'<a href="https://example.test">link</a>',
		'<div role="button">Play</div>',
		'<div role="row"><span>Unreadable row</span></div>',
		"<span>Text outside the live region</span>",
	]) {
		setMessages(wrap(extra));
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
	// aria-live=off is not a live announcement.
	setMessages(`${base}<div data-scope="messages_table"><span aria-live="off">Wiktor testowy pisze</span></div>`);
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
	);
	// Directional text outside the live region is message content, not status.
	setMessages(wrap('<span dir="auto">Real message</span>'));
	assert.deepEqual(
		(await messengerChatAdapter.readConversation()).messages.map(({ text }) => text),
		["Hello", "Real message"],
	);
});

test("ignores the visible typing bubble through its announcement-only residue", async () => {
	const dom = setup();
	const base =
		'<div data-scope="messages_table" data-message-id="1" aria-roledescription="message" aria-label="At 11:12, Alex: Hello"><span dir="auto">Hello</span></div>';
	for (const bubble of [typingBubble, typingBubbleDirect]) {
		setMessages(base);
		const before = await messengerChatAdapter.readConversation();
		// The bubble appears without remounting the messages.
		document.querySelector("main")!.insertAdjacentHTML("beforeend", bubble);
		const visible = await messengerChatAdapter.readConversation();
		assert.deepEqual(visible.messages, before.messages);
		assert.equal(visible.revision, before.revision);
		// The visual bubble disappears, leaving the residual announcement.
		document.querySelector('[aria-hidden="true"]')!.remove();
		const residual = await messengerChatAdapter.readConversation();
		assert.deepEqual(residual.messages, before.messages);
		assert.equal(residual.revision, before.revision);
		// The announcement disappears too.
		document.querySelector("[aria-live]")!.closest('[data-scope="messages_table"]')!.remove();
		const gone = await messengerChatAdapter.readConversation();
		assert.deepEqual(gone.messages, before.messages);
		assert.equal(gone.revision, before.revision);
	}
});

test("does not hide message content in the typing bubble visual subtree", async () => {
	const dom = setup();
	const base = '<div data-scope="messages_table"><div role="row"><span dir="auto">Hello</span></div></div>';
	const dots = () => [...document.querySelectorAll('[aria-hidden="true"] div[role="presentation"]')].at(-1)!;
	for (const extra of [
		'<div data-message-id="9"></div>',
		'<div role="row"><span>Row</span></div>',
		'<img alt="photo">',
		'<a href="https://example.test">link</a>',
		"<span>Extra text</span>",
	]) {
		setMessages(base + typingBubble);
		dots().insertAdjacentHTML("beforeend", extra);
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
	// The avatar label and static shapes are part of the recognized indicator.
	for (const mutate of [
		(svg: Element) => svg.removeAttribute("aria-label"),
		(svg: Element) => svg.insertAdjacentHTML("beforeend", "<text>hi</text>"),
	]) {
		setMessages(base + typingBubble);
		mutate(document.querySelector('[aria-hidden="true"] svg')!);
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
	// List shapes that do not match the observed typing avatar stay unrecognized.
	for (const list of [
		"<div></div>",
		`<div>hello</div><div role="listitem"><div>${typingAvatar}</div></div>`,
		`<div role="listitem"><div>${typingAvatar}</div>hello</div>`,
		`<div role="listitem"><div>${typingAvatar}</div><div></div></div>`,
		`<div role="listitem"><div dir="auto">${typingAvatar}</div></div>`,
	]) {
		setMessages(base + typingBubbleFor(list));
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
	// Directional text alongside the bubble is message content, not status.
	setMessages(base + typingBubble);
	document
		.querySelector("[aria-live]")!
		.closest('[data-scope="messages_table"]')!
		.querySelector(":scope > div")!
		.insertAdjacentHTML("beforeend", '<span dir="auto">Real message</span>');
	assert.deepEqual(
		(await messengerChatAdapter.readConversation()).messages.map(({ text }) => text),
		["Hello", "Real message"],
	);
});
