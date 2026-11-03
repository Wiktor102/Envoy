import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { ConversationUnavailableError, messengerChatAdapter } from "../src/messenger/chat-adapter";
import { replyAndReactionFixture, setMessages, setup } from "./support/conversation-fixtures";

const singleMessage = `<div data-scope="messages_table"><div role="row"><div dir="auto">Hello</div></div></div>`;

// Mirrors the observed encrypted 1-1 header: a profile link with the display
// name outside the message table, inside the conversation region, plus the
// region-label heading as a sibling of that region.
function headerConversation(header: string, headingTag: string, headingText: string, labelledby = true): string {
	const heading = headingText ? `<${headingTag} id="thread-label">${headingText}</${headingTag}>` : "";
	return `${heading}<div role="region"${labelledby ? ' aria-labelledby="thread-label"' : ""}>${header}${singleMessage}</div>`;
}

const profileLink = (name: string) =>
	`<a role="link" href="https://www.messenger.com/user/123"><h3 dir="auto">${name}</h3></a>`;

// Mirrors the observed group runs: every bubble carries its own boundary
// label with the author, while only the first bubble of a run keeps a sender
// heading. Second bubbles have no heading at all.
function labeledBubble(id: string, roledescription: string, label: string, heading: string | null, text: string): string {
	return (
		`<div data-scope="messages_table" data-message-id="${id}" aria-roledescription="${roledescription}" aria-label="${label}">` +
		(heading ? `<h4 dir="auto">${heading}</h4>` : "") +
		`<span dir="auto">${text}</span></div>`
	);
}

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
	}
});

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
});

test("changes the revision when a quoted reply changes", async () => {
	const dom = setup();
	setMessages(replyAndReactionFixture);
	const original = await messengerChatAdapter.readConversation();
	document.querySelector('[role="button"][aria-label*="odpowiadasz"] [dir="auto"]')!.textContent = "Different quote";
	const changed = await messengerChatAdapter.readConversation();
	assert.notEqual(changed.revision, original.revision);
});

test("attributes fresh text and emoji bubbles sharing a container with a delivery status", async () => {
	const dom = setup();
	for (const [text, body] of [
		["Hi there", "Hi there"],
		["🤖", '<img alt="🤖">'],
	]) {
		for (const [sender, direction] of [
			["Ty", "outgoing"],
			["Alex", "incoming"],
		]) {
			setMessages(`<div data-scope="messages_table" data-message-id="1" aria-roledescription="wiadomość" aria-label="O 21:58, ${sender}: ${text}">
				<span dir="auto">${body}</span><span dir="auto">Wysłano</span>
				<button aria-label="1 reaction">👍</button></div>`);
			const snapshot = await messengerChatAdapter.readConversation();
			assert.deepEqual(
				snapshot.messages.map(({ text, direction }) => [text, direction]),
				[
					[text, direction],
					["Wysłano", "unknown"],
				],
			);
			assert.deepEqual(
				snapshot.messages.map(({ reactions }) => reactions),
				[[], []],
			);
			// Conflicting metadata must still fail closed.
			document
				.querySelector("[data-message-id]")!
				.setAttribute("data-message-direction", direction === "outgoing" ? "incoming" : "outgoing");
			assert.equal((await messengerChatAdapter.readConversation()).messages[0]!.direction, "unknown");
		}
	}
});

test("does not attribute shared-container text without a unique match to the message label", async () => {
	const dom = setup();
	for (const label of ["O 21:58, Ty: Other", "O 21:58, Ty: Hi", "O 21:58, Ty", "You sent"]) {
		setMessages(`<div data-scope="messages_table" data-message-id="1" aria-roledescription="wiadomość" aria-label="${label}">
			<span dir="auto">Hi</span><span dir="auto">Hi</span></div>`);
		assert.deepEqual(
			(await messengerChatAdapter.readConversation()).messages.map(({ direction }) => direction),
			["unknown", "unknown"],
		);
	}
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
});

test("changes the revision when a message is unsent", async () => {
	const dom = setup();
	setMessages('<div data-scope="messages_table"><div role="row"><span dir="auto">Can we meet at 5?</span></div></div>');
	const original = await messengerChatAdapter.readConversation();
	document.querySelector('[dir="auto"]')!.textContent = "Alex unsent a message";
	const changed = await messengerChatAdapter.readConversation();
	assert.equal(changed.messages[0]!.unsent, true);
	assert.notEqual(changed.revision, original.revision);
});

test("preserves Likes and ignores delivery footers when another message is unsent", async () => {
	const dom = setup();
	setMessages(`
		<div data-scope="messages_table" data-message-id="like" aria-roledescription="message" aria-label="At 19:03, Alex: 👍"><div role="img" aria-label="Like, thumbs up"><svg><title>Like, thumbs up</title></svg></div></div>
		<div data-scope="messages_table" data-message-id="text" aria-roledescription="message" aria-label="At 19:05, You: Hi"><span dir="auto">Hi</span><div><span role="presentation"><span dir="auto"><span>Sent 1 minute ago</span></span></span></div></div>`);
	const original = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		original.messages.map(({ text, direction, unsent }) => [text, direction, unsent]),
		[
			["👍", "incoming", false],
			["Hi", "outgoing", false],
		],
	);
	const message = document.querySelector('[data-message-id="text"]')!;
	message.querySelector('[dir="auto"]')!.textContent = "You unsent a message";
	message.setAttribute("aria-label", "At 19:05, You: You unsent a message");
	const changed = await messengerChatAdapter.readConversation();
	assert.deepEqual(
		changed.messages.map(({ text, direction, unsent }) => [text, direction, unsent]),
		[
			["👍", "incoming", false],
			["", "outgoing", true],
		],
	);
	assert.notEqual(changed.revision, original.revision);
	message.querySelector('span[role="presentation"] span span')!.textContent = "Sent 2 minutes ago";
	assert.equal((await messengerChatAdapter.readConversation()).revision, changed.revision);
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
});

test("reads the 1-1 chat name from the header in English and Polish", async () => {
	const dom = setup();
	for (const [headingTag, headingText] of [
		["h3", "Conversation with Wiktor Golicz"],
		["h2", "Konwersacja z: Wiktor Golicz"],
	]) {
		setMessages(headerConversation(profileLink("Wiktor Golicz"), headingTag, headingText));
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(snapshot.participants, ["Wiktor Golicz"]);
		assert.deepEqual(
			snapshot.messages.map(({ text }) => text),
			["Hello"],
		);
	}
});

test("keeps the revision stable when the chat name changes or is missing", async () => {
	const dom = setup();
	setMessages(headerConversation(profileLink("Wiktor Golicz"), "h3", "Conversation with Wiktor Golicz"));
	const first = await messengerChatAdapter.readConversation();
	assert.deepEqual(first.participants, ["Wiktor Golicz"]);
	setMessages(headerConversation(profileLink("Alex"), "h3", "Conversation with Alex"));
	const renamed = await messengerChatAdapter.readConversation();
	assert.deepEqual(renamed.participants, ["Alex"]);
	assert.equal(renamed.revision, first.revision);
	setMessages(singleMessage);
	const missing = await messengerChatAdapter.readConversation();
	assert.deepEqual(missing.participants, []);
	assert.equal(missing.revision, first.revision);
});

test("leaves participants empty when the header is not a 1-1 profile link", async () => {
	const dom = setup();
	for (const html of [
		// Named group: the heading sits in a button, with zero link candidates.
		headerConversation('<div role="button"><h3 dir="auto">Weekend trip</h3></div>', "h3", "Weekend trip"),
		// Unavailable user: a heading with no enclosing profile link.
		headerConversation('<h3 dir="auto">Facebook User</h3>', "h3", "Conversation with Facebook User"),
		// No header at all, even with a matching region heading.
		headerConversation("", "h3", "Conversation with Wiktor Golicz"),
		// Two profile links are ambiguous.
		headerConversation(profileLink("Wiktor Golicz") + profileLink("Alex"), "h3", "Conversation with Wiktor Golicz"),
		// A profile card inside the message table is unstable history, never the header.
		`<h3 id="thread-label">Conversation with Wiktor Golicz</h3><div role="region" aria-labelledby="thread-label"><div data-scope="messages_table"><div role="row"><div dir="auto">Hello</div></div>${profileLink("Wiktor Golicz")}</div></div>`,
	]) {
		setMessages(html);
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(snapshot.participants, []);
		assert.deepEqual(
			snapshot.messages.map(({ text }) => text),
			["Hello"],
		);
	}
});

test("reads per-message sender labels across consecutive bubbles in English and Polish", async () => {
	const dom = setup();
	for (const [roledescription, bubbles] of [
		[
			"wiadomość",
			[
				["O 17:20, Ty: Envoy author test A1", "Wysłano", "Envoy author test A1", "Ty", "outgoing"],
				["O 17:20, Ty: Envoy author test A2", null, "Envoy author test A2", "Ty", "outgoing"],
				[
					"O 17:20, Wiktor testowy: Envoy author test B1",
					"Wiktor testowy",
					"Envoy author test B1",
					"Wiktor testowy",
					"incoming",
				],
				[
					"O 17:20, Wiktor testowy: Envoy author test B2: noted, thanks",
					null,
					"Envoy author test B2: noted, thanks",
					"Wiktor testowy",
					"incoming",
				],
			],
		],
		[
			"message",
			[
				["At 5:20 PM, Wiktor: Envoy author test A1", "Wiktor", "Envoy author test A1", "Wiktor", "incoming"],
				["At 5:20 PM, Wiktor: Envoy author test A2", null, "Envoy author test A2", "Wiktor", "incoming"],
				["At 5:20 PM, You: Envoy author test B1", "You sent", "Envoy author test B1", "You", "outgoing"],
				["At 5:20 PM, You: Envoy author test B2", null, "Envoy author test B2", "You", "outgoing"],
			],
		],
	] as const) {
		setMessages(
			bubbles
				.map(([label, heading, text], index) =>
					labeledBubble(`message-${index}`, roledescription, label, heading, text),
				)
				.join(""),
		);
		// The same message is labeled Ty/You for its author and a name for the
		// other account. The raw label is kept as-is; direction already carries
		// the You/Ty distinction, so no normalization happens here.
		assert.deepEqual(
			(await messengerChatAdapter.readConversation()).messages.map(({ text, direction, sender }) => [
				text,
				direction,
				sender,
			]),
			bubbles.map(([label, heading, text, sender, direction]) => [text, direction, sender]),
		);
	}
});

test("reads the sender of an attachment-only label without a message body", async () => {
	const dom = setup();
	setMessages(`<div data-scope="messages_table" data-message-id="photo" aria-roledescription="wiadomość" aria-label="O 12:56, Ty">
		<h4 dir="auto">Wysłano</h4>
		<div role="button" tabindex="-1"><div><img alt="Otwórz zdjęcie" src="https://example.test/photo"></div></div>
	</div>`);
	assert.deepEqual(
		(await messengerChatAdapter.readConversation()).messages.map(({ text, direction, sender, attachments }) => ({
			text,
			direction,
			sender,
			urls: attachments.map(({ url }) => url),
		})),
		[{ text: "", direction: "outgoing", sender: "Ty", urls: ["https://example.test/photo"] }],
	);
});

test("leaves the sender null for missing or malformed labels while keeping attribution", async () => {
	const dom = setup();
	setMessages(`
		<div data-scope="messages_table" data-message-id="1" data-message-direction="incoming"><span dir="auto">Hello</span></div>
		<div data-scope="messages_table" data-message-id="2" data-message-direction="outgoing" aria-roledescription="message" aria-label="Yesterday"><span dir="auto">Hi</span></div>
		<div data-scope="messages_table" data-message-id="3" data-message-direction="incoming" aria-roledescription="wiadomość" aria-label="O 17:20"><span dir="auto">Again</span></div>`);
	assert.deepEqual(
		(await messengerChatAdapter.readConversation()).messages.map(({ direction, sender }) => [direction, sender]),
		[
			["incoming", null],
			["outgoing", null],
			["incoming", null],
		],
	);
});

test("leaves the sender null when a labeled boundary is shared by multiple messages", async () => {
	const dom = setup();
	setMessages(`<div data-scope="messages_table" data-message-id="1" aria-roledescription="wiadomość" aria-label="O 21:58, Alex: Hi">
		<span dir="auto">Hi</span><span dir="auto">Hi</span></div>`);
	assert.deepEqual(
		(await messengerChatAdapter.readConversation()).messages.map(({ direction, sender }) => [direction, sender]),
		[
			["unknown", null],
			["unknown", null],
		],
	);
});

test("keeps the sender for the unique match sharing a container with a delivery status", async () => {
	const dom = setup();
	setMessages(`<div data-scope="messages_table" data-message-id="1" aria-roledescription="wiadomość" aria-label="O 21:58, Ty: Hi there">
		<span dir="auto">Hi there</span><span dir="auto">Wysłano</span>
		<button aria-label="1 reaction">👍</button></div>`);
	assert.deepEqual(
		(await messengerChatAdapter.readConversation()).messages.map(({ text, direction, sender }) => [
			text,
			direction,
			sender,
		]),
		[
			["Hi there", "outgoing", "Ty"],
			["Wysłano", "unknown", null],
		],
	);
});

test("keeps the revision when a sender label changes during loading", async () => {
	const dom = setup();
	setMessages(
		`<div data-scope="messages_table" data-message-id="1" aria-roledescription="wiadomość" aria-label="O 17:20, Mikołaj Gaweł: Hello"><span dir="auto">Hello</span></div>`,
	);
	const first = await messengerChatAdapter.readConversation();
	assert.equal(first.messages[0]!.sender, "Mikołaj Gaweł");
	// A loading rename changes the label without changing the message.
	document.querySelector("[data-message-id]")!.setAttribute("aria-label", "O 17:20, Mikołaj: Hello");
	const renamed = await messengerChatAdapter.readConversation();
	assert.equal(renamed.messages[0]!.sender, "Mikołaj");
	assert.equal(renamed.revision, first.revision);
	assert.deepEqual(
		renamed.messages.map(({ sender: _sender, ...message }) => message),
		first.messages.map(({ sender: _sender, ...message }) => message),
	);
});

test("stays current when a sender label changes while its revision is hashing", async () => {
	const dom = setup();
	setMessages(
		`<div data-scope="messages_table" data-message-id="1" aria-roledescription="wiadomość" aria-label="O 17:20, Mikołaj Gaweł: Hello"><span dir="auto">Hello</span></div>`,
	);
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
	document.querySelector("[data-message-id]")!.setAttribute("aria-label", "O 17:20, Mikołaj: Hello");
	resolveDigest(new ArrayBuffer(32));
	const snapshot = await pending;
	assert.deepEqual(
		snapshot.messages.map(({ text, direction }) => [text, direction]),
		[["Hello", "incoming"]],
	);
});

test("leaves participants empty without a corroborating region heading", async () => {
	const dom = setup();
	for (const html of [
		// The region names no label.
		headerConversation(profileLink("Wiktor Golicz"), "", "", false),
		// The label points nowhere.
		`<div role="region" aria-labelledby="missing-label">${profileLink("Wiktor Golicz")}${singleMessage}</div>`,
		// The label names a different person than the header link.
		headerConversation(profileLink("Wiktor Golicz"), "h3", "Conversation with Alex"),
		// The label is not a conversation heading.
		headerConversation(profileLink("Wiktor Golicz"), "h3", "Chats"),
		// The label is not a heading element.
		`<div id="thread-label">Conversation with Wiktor Golicz</div><div role="region" aria-labelledby="thread-label">${profileLink("Wiktor Golicz")}${singleMessage}</div>`,
	]) {
		setMessages(html);
		const snapshot = await messengerChatAdapter.readConversation();
		assert.deepEqual(snapshot.participants, []);
		assert.deepEqual(
			snapshot.messages.map(({ text }) => text),
			["Hello"],
		);
	}
});
