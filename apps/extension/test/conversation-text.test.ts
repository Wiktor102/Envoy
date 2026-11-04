import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { ConversationUnavailableError, messengerChatAdapter } from "../src/messenger/chat-adapter";
import { fixture, setMessages, setup } from "./support/conversation-fixtures";

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
});

test("ignores the zero-height empty message scope beside Messenger's newest article", async () => {
	const dom = setup();
	// Observed in signed-in Chrome: the final MWMessageRow contains an article
	// and a sibling scope with one empty presentation div. It has a client rect
	// even though its height is zero.
	const article =
		'<div role="article"><div data-scope="messages_table" data-message-id="1" aria-roledescription="wiadomość" aria-label="O 14:34, Alex: Hello"><span dir="auto">Hello</span></div></div>';
	const empty =
		'<div data-scope="messages_table" data-release-focus-from="CLICK" tabindex="0"><div role="presentation"></div></div>';
	setMessages(`<div role="none">${article}<div role="none">${empty}</div></div>`);
	const before = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		before.messages.map(({ text, direction }) => [text, direction]),
		[["Hello", "incoming"]],
	);
	document.querySelector("[data-message-id]")!.closest('[role="article"]')!.nextElementSibling!.remove();
	assert.equal((await messengerChatAdapter.readConversation()).revision, before.revision);

	// An empty scope alone is not a readable conversation.
	setMessages(empty);
	await assert.rejects(messengerChatAdapter.readConversation(), ConversationUnavailableError);
});

test("does not hide message metadata or unsupported content in an empty-looking scope", async () => {
	const dom = setup();
	for (const extra of [
		'<div data-message-id="loading"></div>',
		'<div aria-roledescription="wiadomość"></div>',
		'<div data-message-type="voice"></div>',
		'<div data-attachment-type="file"></div>',
		'<div aria-label="Voice message"></div>',
		'<span dir="auto"></span>',
		"<video></video>",
		'<div role="button"></div>',
		"<span>Unreadable message</span>",
	]) {
		setMessages(`${fixture}<div data-scope="messages_table"><div role="presentation">${extra}</div></div>`);
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
	setMessages(`${fixture}<div data-scope="messages_table"><div role="presentation"></div></div>`);
	const scope = document.querySelector<HTMLElement>('[data-scope="messages_table"]:last-child')!;
	scope.getBoundingClientRect = () => ({ height: 20 }) as DOMRect;
	await assert.rejects(messengerChatAdapter.readConversation(), ConversationUnavailableError);
});

test("does not classify message bodies in accessibility labels as attachment metadata", async () => {
	const dom = setup();
	for (const text of ["Po prostu zamknij plik", "A video call?", "Send a GIF", "A voice message", "sticker", "audio"]) {
		setMessages(`<div role="article"><div data-scope="messages_table" data-message-id="1" aria-roledescription="wiadomość" aria-label="O 19 października 2026 13:18, Ty: ${text}"><span dir="auto"><div dir="auto">${text}</div></span></div></div>
			<div data-scope="messages_table"><div role="presentation"></div></div>`);
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(
			snapshot.messages.map(({ text, direction }) => [text, direction]),
			[[text, "outgoing"]],
		);
		const scope = document.querySelector("[data-message-id]")!;
		// The per-message label doesn't override actual media metadata or controls.
		scope.setAttribute("data-message-type", "voice");
		await assert.rejects(messengerChatAdapter.readConversation(), ConversationUnavailableError);
		scope.removeAttribute("data-message-type");
		scope.insertAdjacentHTML("beforeend", '<div role="button" aria-label="Play voice message"></div>');
		await assert.rejects(messengerChatAdapter.readConversation(), ConversationUnavailableError);
	}
});

test("reads standalone Messenger Likes as messages with their sender and revision", async () => {
	const dom = setup();
	setMessages(`
		<div role="article"><div data-scope="messages_table" data-message-id="1" aria-roledescription="wiadomość" aria-label="O poniedziałek 11:11, Alex: Hello"><span dir="auto">Hello</span></div></div>
		<div role="article"><div data-scope="messages_table" data-message-id="2" aria-roledescription="wiadomość" aria-label="O poniedziałek 11:12, Ty: 👍"><div role="img" aria-label="Like, thumbs up"><svg><title>Like, thumbs up</title></svg></div></div></div>`);
	const first = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		first.messages.map(({ text, direction }) => [text, direction]),
		[
			["Hello", "incoming"],
			["👍", "outgoing"],
		],
	);
	const last = document.querySelector('[data-message-id="2"]')!;
	last.setAttribute("aria-label", "O poniedziałek 11:12, Alex: 👍");
	const changed = await messengerChatAdapter.readConversation();
	assert.equal(changed.messages[1]!.direction, "incoming");
	assert.notEqual(changed.revision, first.revision);
	last.querySelector('[role="img"]')!.setAttribute("aria-label", "Unknown illustration");
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
	);
});

test("does not mistake reactions or mixed content for a standalone Like", async () => {
	const dom = setup();
	const like = '<div role="img" aria-label="Like, thumbs up"><svg><title>Like, thumbs up</title></svg></div>';
	const message = (body: string, label = "👍") =>
		`<div role="article"><div data-scope="messages_table" data-message-id="1" aria-roledescription="wiadomość" aria-label="O 11:12, Ty: ${label}">${body}</div></div>`;
	setMessages(message(`<span dir="auto">Hello</span><div role="button" aria-label="reaction">${like}</div>`, "Hello"));
	assert.equal((await messengerChatAdapter.readConversation()).messages[0]!.text, "Hello");
	for (const body of [
		`${like}<span dir="auto">Other content</span>`,
		`${like}${like}`,
		`<div role="img" aria-label="Like, thumbs up"><svg></svg><video></video></div>`,
	]) {
		setMessages(message(body));
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
	setMessages(message(like, "Other content"));
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
	);
	setMessages(
		message(
			'<div role="img" dir="auto" aria-label="Like, thumbs up"><svg><title>Like</title></svg></div>',
			"Other content",
		),
	);
	await assert.rejects(
		messengerChatAdapter.readConversation(),
		(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
	);
});

test("omits edit labels while preserving edited text, attribution, and revision changes", async () => {
	const dom = setup();
	for (const [sender, status] of [
		["Alex", "Edytowano"],
		["You", "Edited"],
	]) {
		setMessages(`<div data-scope="messages_table" data-message-id="1" aria-roledescription="message" aria-label="At 11:12, ${sender}: Updated text">
			<h4 dir="auto">${sender} · ${status}</h4>
			<div><span dir="auto">Updated text</span></div>
			<div role="presentation"><div role="presentation"><span dir="auto"><span><span><div role="button" aria-expanded="false" aria-label="${status}" tabindex="-1"><span>${status}</span></div></span></span></span></div></div>
		</div>`);
		const original = await messengerChatAdapter.readConversation();
		assert.deepEqual(
			original.messages.map(({ text, direction }) => [text, direction]),
			[["Updated text", sender === "You" ? "outgoing" : "incoming"]],
		);
		document.querySelector("h4")!.remove();
		document.querySelectorAll('[dir="auto"]')[1]!.remove();
		assert.equal((await messengerChatAdapter.readConversation()).revision, original.revision);
		document.querySelector('[dir="auto"]')!.textContent = "Edited again";
		document.querySelector("[data-message-id]")!.setAttribute("aria-label", `At 11:12, ${sender}: Edited again`);
		const changed = await messengerChatAdapter.readConversation();
		assert.equal(changed.messages[0]!.text, "Edited again");
		assert.notEqual(changed.revision, original.revision);
	}
});

test("preserves literal edit-label messages and uncertain text", async () => {
	const dom = setup();
	for (const status of ["Edytowano", "Edited"]) {
		setMessages(
			`<div data-scope="messages_table" data-message-id="1" aria-roledescription="message" aria-label="At 11:12, Alex: ${status}"><span dir="auto">${status}</span></div>`,
		);
		assert.equal((await messengerChatAdapter.readConversation()).messages[0]!.text, status);
		// A label in another message must not justify dropping this text.
		setMessages(`<div data-scope="messages_table" data-message-id="1" aria-roledescription="message" aria-label="At 11:12, Alex: Hello"><span dir="auto">Hello</span></div>
			<div data-scope="messages_table"><span dir="auto">${status}</span></div>`);
		assert.deepEqual(
			(await messengerChatAdapter.readConversation()).messages.map(({ text }) => text),
			["Hello", status],
		);
		setMessages(
			`<div data-scope="messages_table" data-message-id="1" aria-roledescription="message" aria-label="At 11:12, Alex: Missing text"><span dir="auto">${status}</span></div>`,
		);
		assert.equal((await messengerChatAdapter.readConversation()).messages[0]!.text, status);
	}
});

test("ignores control wrappers by structure regardless of language or message labels", async () => {
	const dom = setup();
	for (const control of [
		'<div role="button" aria-expanded="false" tabindex="-1">Modifié</div>',
		"<button>Bearbeitet</button>",
	]) {
		setMessages(
			`<div data-scope="messages_table"><span dir="auto">Hello</span><span dir="auto"> <span>${control}</span> </span></div>`,
		);
		assert.deepEqual(
			(await messengerChatAdapter.readConversation()).messages.map(({ text }) => text),
			["Hello"],
		);
		// Content beside a control must not be silently discarded.
		setMessages(`<div data-scope="messages_table"><span dir="auto">Actual text ${control}</span></div>`);
		assert.equal((await messengerChatAdapter.readConversation()).messages.length, 1);
		setMessages(`<div data-scope="messages_table"><span dir="auto"><video></video>${control}</span></div>`);
		await assert.rejects(messengerChatAdapter.readConversation(), ConversationUnavailableError);
	}
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
});

for (const quoted of [false, true]) {
	test(`preserves line breaks and revisions in ${quoted ? "quoted replies" : "message text"}`, async () => {
		const dom = setup();
		const html = `<div data-scope="messages_table"><div role="row" data-message-direction="incoming">${
			quoted
				? '<div role="button" aria-label="View original message"><span dir="auto">10<br>30</span></div><span dir="auto">My answer</span>'
				: '<span dir="auto">10<br>30</span>'
		}</div></div>`;
		setMessages(html);
		const original = await messengerChatAdapter.readConversation();
		const textOf = (snapshot: typeof original) =>
			quoted ? snapshot.messages[0]!.replyTo?.text : snapshot.messages[0]!.text;
		assert.equal(textOf(original), "10\n30");
		assert.equal(original.messages[0]!.direction, "incoming");
		if (quoted) assert.equal(original.messages[0]!.text, "My answer");

		setMessages(html);
		const remounted = await messengerChatAdapter.readConversation();
		assert.notEqual(remounted.messages[0]!.id, original.messages[0]!.id);
		assert.equal(remounted.revision, original.revision);

		const text = document.querySelector('[dir="auto"]')!;
		const revisions = [original.revision];
		for (const [content, expected] of [
			["1030", "1030"],
			["1<br>030", "1\n030"],
			["10<br><br>30", "10\n\n30"],
			["<br>1030<br>", "\n1030\n"],
		] as const) {
			text.innerHTML = content;
			const changed = await messengerChatAdapter.readConversation();
			assert.equal(textOf(changed), expected);
			assert.equal(changed.messages[0]!.id, remounted.messages[0]!.id);
			assert.ok(!revisions.includes(changed.revision));
			revisions.push(changed.revision);
		}
	});

	test(`preserves rendered block separators in ${quoted ? "quoted replies" : "message text"}`, async () => {
		const dom = setup();
		for (const [content, expected] of [
			["<div>10</div><div>30</div>", "10\n30"],
			["<p>10</p><p>30</p>", "10\n30"],
			['10<span style="display: block">30</span>40', "10\n30\n40"],
			["<div><div>10</div><div>30</div></div>", "10\n30"],
			["<div>10<br></div><div>30</div>", "10\n30"],
			["<div>10</div><div><br></div><div>30</div>", "10\n\n30"],
			['<div>10<img alt="👍🏽"></div><div>30</div>', "10👍🏽\n30"],
			['<div style="display: inline">10</div><div style="display: inline">30</div>', "1030"],
			['10<span style="display: inline-block"><div>30</div><div>40</div></span>50', "1030\n4050"],
			['10<span style="display: inline-block"><br>30<br></span>40', "10\n30\n40"],
			['10<div><span style="display: inline-block"><div>30</div></span></div>40', "10\n30\n40"],
		] as const) {
			setMessages(
				`<div data-scope="messages_table"><div role="row" data-message-direction="incoming">${
					quoted
						? `<div role="button" aria-label="View original message"><span dir="auto">${content}</span></div><span dir="auto">My answer</span>`
						: `<span dir="auto">${content}</span>`
				}</div></div>`,
			);
			const original = await messengerChatAdapter.readConversation();
			const textOf = (snapshot: typeof original) =>
				quoted ? snapshot.messages[0]!.replyTo?.text : snapshot.messages[0]!.text;
			assert.equal(textOf(original), expected, content);

			const text = document.querySelector('[dir="auto"]')!;
			text.textContent = expected.replaceAll("\n", "");
			const changed = await messengerChatAdapter.readConversation();
			assert.equal(textOf(changed), text.textContent);
			if (expected.includes("\n")) assert.notEqual(changed.revision, original.revision, content);
			else assert.equal(changed.revision, original.revision, content);
		}
	});

	test(`isolates block boundaries inside atomic inline boxes in ${quoted ? "quoted replies" : "message text"}`, async () => {
		const dom = setup();
		for (const display of ["inline-block", "inline-flex", "inline-grid", "inline-table"]) {
			const content = `10<span style="display: ${display}"><div>30</div></span>40`;
			setMessages(
				`<div data-scope="messages_table"><div role="row" data-message-direction="incoming">${
					quoted
						? `<div role="button" aria-label="View original message"><span dir="auto">${content}</span></div><span dir="auto">My answer</span>`
						: `<span dir="auto">${content}</span>`
				}</div></div>`,
			);
			const original = await messengerChatAdapter.readConversation();
			const textOf = (snapshot: typeof original) =>
				quoted ? snapshot.messages[0]!.replyTo?.text : snapshot.messages[0]!.text;
			assert.equal(textOf(original), "103040", display);

			const text = document.querySelector('[dir="auto"]')!;
			// An ordinary inline wrapper lets the block split the surrounding line.
			text.querySelector<HTMLElement>("span")!.style.display = "inline";
			const changed = await messengerChatAdapter.readConversation();
			assert.equal(textOf(changed), "10\n30\n40", display);
			assert.equal(changed.messages[0]!.id, original.messages[0]!.id);
			assert.notEqual(changed.revision, original.revision, display);

			text.innerHTML = "10<br>30<br>40";
			const explicitBreaks = await messengerChatAdapter.readConversation();
			assert.equal(explicitBreaks.revision, changed.revision, display);
			text.textContent = "103040";
			const flattened = await messengerChatAdapter.readConversation();
			assert.equal(flattened.revision, original.revision, display);
		}
	});
}

test("rejects inline media whose alternative text is not exclusively emoji", async () => {
	const dom = setup();
	for (const media of ['<img alt="photo 1">', '<img alt="😀2">', '<img alt="">', "<svg></svg>"]) {
		setMessages(`<div data-scope="messages_table"><div role="row"><span dir="auto">Hello ${media}</span></div></div>`);
		await assert.rejects(
			messengerChatAdapter.readConversation(),
			(error: unknown) => error instanceof ConversationUnavailableError && error.reason === "unsupported",
		);
	}
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

	const reloadedDom = setup();
	setMessages(fixture);
	const reloaded = await messengerChatAdapter.readConversation();
	assert.notDeepEqual(
		reloaded.messages.map(({ id }) => id),
		original.messages.map(({ id }) => id),
	);
	assert.equal(reloaded.revision, original.revision);
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
});

test("omits Messenger delivery footers without changing real text, emoji, or revisions", async () => {
	const dom = setup();
	// Structure captured from Chrome, with synthetic message content.
	const footer = (text: string) =>
		`<div><span role="presentation"><span dir="auto"><span>${text}</span></span></span></div>`;
	for (const [text, body] of [
		["Hello", "Hello"],
		["🤖", '<img alt="🤖">'],
		["Wysłano 9 min temu", "Wysłano 9 min temu"],
	]) {
		setMessages(`<div data-scope="messages_table" data-message-id="1" aria-roledescription="wiadomość" aria-label="O 21:59, Ty: ${text}">
			<h4 dir="auto">Wysłano</h4><div><span dir="auto">${body}</span></div>${footer("Wysłano 10 min temu")}</div>`);
		const before = await messengerChatAdapter.readConversation();
		assert.deepEqual(
			before.messages.map(({ text, direction }) => [text, direction]),
			[[text, "outgoing"]],
		);
		document.querySelector('span[role="presentation"] span span')!.textContent = "Wysłano 11 min temu";
		assert.equal((await messengerChatAdapter.readConversation()).revision, before.revision);
	}
	// An unmatched or differently structured candidate is still unknown content.
	for (const status of [footer("Something else"), '<div><span dir="auto">Wysłano 9 min temu</span></div>']) {
		setMessages(
			`<div data-scope="messages_table" data-message-id="1" aria-roledescription="wiadomość" aria-label="O 21:59, Ty: Hello"><div dir="auto">Hello</div>${status}</div>`,
		);
		assert.equal((await messengerChatAdapter.readConversation()).messages.length, 2);
	}
});

test("reads a blockquote reply with its quote markers, attribution, and delivery footer", async () => {
	const dom = setup();
	// Observed rendering: a "> "-prefixed message becomes a blockquote whose
	// visible text omits the markers, while the per-message label keeps them.
	setMessages(`
		<div role="article"><div data-scope="messages_table" data-message-id="1" aria-roledescription="message" aria-label="At 14:48, Alex: Hello"><span dir="auto">Hello</span></div></div>
		<div role="article"><div data-scope="messages_table" data-message-id="2" aria-roledescription="message" aria-label="At 14:49, You: > Hi there">
			<div><span dir="auto"><div dir="auto"><blockquote>Hi there</blockquote></div></span></div>
			<div><span role="presentation"><span dir="auto"><span>Sent 1 minute ago</span></span></span></div>
		</div></div>`);
	const snapshot = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		snapshot.messages.map(({ text, direction }) => [text, direction]),
		[
			["Hello", "incoming"],
			["> Hi there", "outgoing"],
		],
	);
	// The delivery footer is still a footer, and its elapsed wording does not
	// affect the revision.
	document.querySelector('span[role="presentation"] span span')!.textContent = "Sent 2 minutes ago";
	assert.equal((await messengerChatAdapter.readConversation()).revision, snapshot.revision);
	// Quote text changes the revision like any other message text.
	document.querySelector("blockquote")!.textContent = "Changed";
	document.querySelector('[data-message-id="2"]')!.setAttribute("aria-label", "At 14:49, You: > Changed");
	const changed = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		changed.messages.map(({ text, direction }) => [text, direction]),
		[
			["Hello", "incoming"],
			["> Changed", "outgoing"],
		],
	);
	assert.notEqual(changed.revision, snapshot.revision);
});

test("restores quote markers for nested, multi-line, and mixed blockquotes", async () => {
	const dom = setup();
	for (const [content, expected] of [
		["<blockquote>Hello</blockquote>", "> Hello"],
		["<blockquote>Hello<br>again</blockquote>", "> Hello\n> again"],
		["<blockquote>Hello<br><br>again</blockquote>", "> Hello\n>\n> again"],
		["Before<blockquote>Quoted</blockquote>After", "Before\n> Quoted\nAfter"],
		["<blockquote>outer<blockquote>inner</blockquote></blockquote>", "> outer\n> > inner"],
		["<blockquote><div>one</div><div>two</div></blockquote>", "> one\n> two"],
	] as const) {
		setMessages(
			`<div data-scope="messages_table"><div role="row" data-message-direction="incoming"><span dir="auto">${content}</span></div></div>`,
		);
		const snapshot = await messengerChatAdapter.readConversation();
		assert.equal(snapshot.messages[0]!.text, expected, content);
		assert.equal(snapshot.messages[0]!.direction, "incoming", content);
	}
});

test("reads the edited marker and stable ID for plain text without polluting the body", async () => {
	const dom = setup();
	try {
		const editedMessage = (marker: string, stableId = "mid.$abc") =>
			`<div data-scope="messages_table" data-message-id="${stableId}" aria-roledescription="message" aria-label="At 11:12, Alex: Updated text">` +
			`<h4 dir="auto">Wysłano${marker}</h4><div><span dir="auto">Updated text</span></div></div>`;
		const marker = (label: string) =>
			`<div role="button" aria-label="${label}" tabindex="-1"><span>${label}</span></div>`;

		for (const label of ["Edited", "Edytowano", "EDITED", "edytowano"]) {
			setMessages(editedMessage(marker(label)));
			const [message] = (await messengerChatAdapter.readConversation()).messages;
			assert.equal(message!.text, "Updated text");
			assert.equal(message!.edited, true);
			assert.equal(message!.stableId, "mid.$abc");
		}
		// Any other heading button state is unknown, never "not edited".
		for (const label of ["Hide edits", "Ukryj zmiany", "Something else"]) {
			setMessages(editedMessage(marker(label)));
			assert.equal((await messengerChatAdapter.readConversation()).messages[0]!.edited, null);
		}
		// No heading button means confidently not edited.
		setMessages(editedMessage(""));
		const plain = await messengerChatAdapter.readConversation();
		assert.equal(plain.messages[0]!.edited, false);
		assert.equal(plain.messages[0]!.stableId, "mid.$abc");

		// The marker changes the revision; the stable ID does not.
		setMessages(editedMessage(marker("Edited")));
		assert.notEqual((await messengerChatAdapter.readConversation()).revision, plain.revision);
		setMessages(editedMessage("", "mid.$other"));
		assert.equal((await messengerChatAdapter.readConversation()).revision, plain.revision);

		// Captions and attachments stay unknown rather than inferred.
		setMessages(
			`<div data-scope="messages_table" data-message-id="photo" aria-roledescription="message" aria-label="At 11:12, Alex: A caption">` +
				`<h4 dir="auto">Alex${marker("Edited")}</h4><span dir="auto">A caption</span>` +
				`<a href="/messenger_media/?attachment_id=1"><img alt="" src="https://example.test/photo"></a></div>`,
		);
		const captioned = await messengerChatAdapter.readConversation();
		assert.equal(captioned.messages[0]!.attachments.length, 1);
		assert.equal(captioned.messages[0]!.edited, null);
	} finally {
	}
});

test("marks a reply context uncertain when a heading button co-occurs with the reply", async () => {
	const dom = setup();
	try {
		const reply = (heading: string) =>
			`<div data-scope="messages_table" data-message-id="reply-1">` +
			`<h4 dir="auto">${heading}</h4>` +
			`<div role="button" aria-label="View original message"><span dir="auto">Original text</span></div>` +
			`<span dir="auto">My answer</span></div>`;
		const marker = `<div role="button" aria-label="Edytowano" tabindex="-1"><span>Edytowano</span></div>`;

		setMessages(reply("You replied to Alex"));
		const certain = await messengerChatAdapter.readConversation();
		assert.equal(certain.messages[0]!.replyTo?.context, "You replied to Alex");
		assert.equal(certain.messages[0]!.edited, false);

		// No strip rule is guessed: an edited or unrecognized heading button
		// makes the context uncertain.
		for (const heading of [
			`You replied to Alex${marker}`,
			`You replied to Alex<div role="button" aria-label="Hide edits"><span>Hide</span></div>`,
		]) {
			setMessages(reply(heading));
			const [message] = (await messengerChatAdapter.readConversation()).messages;
			assert.equal(message!.text, "My answer");
			assert.equal(message!.replyTo?.text, "Original text");
			assert.equal(message!.replyTo?.context, null);
		}
		setMessages(reply(`You replied to Alex${marker}`));
		assert.equal((await messengerChatAdapter.readConversation()).messages[0]!.edited, true);
	} finally {
	}
});
