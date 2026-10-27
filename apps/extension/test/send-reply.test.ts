import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { bindMessengerDocument, messengerChatAdapter } from "../src/messenger/chat-adapter";

function setup() {
	const dom = new JSDOM(
		`<main role="main">
			<div data-scope="messages_table"><div role="row" data-message-direction="incoming"><span dir="auto">Hello</span></div></div>
			<div contenteditable="true" role="textbox" aria-label="Message" tabindex="0"></div>
			<button aria-label="Send"></button>
		</main>`,
		{ url: "https://www.messenger.com/t/123" },
	);
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		location: dom.window.location,
		MutationObserver: dom.window.MutationObserver,
	});
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	dom.window.HTMLElement.prototype.getClientRects = () => [1] as unknown as DOMRectList;
	const main = document.querySelector<HTMLElement>("main")!;
	main.style.overflowY = "auto";
	Object.defineProperty(main, "clientHeight", { configurable: true, value: 400 });
	Object.defineProperty(main, "scrollHeight", { configurable: true, value: 400 });
	const editor = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
	const button = document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
	Object.defineProperty(document, "execCommand", {
		configurable: true,
		value: (action: string, _showUi: boolean, text?: string) => {
			if (action === "insertText") editor.textContent = text ?? "";
			else if (action === "delete") editor.textContent = "";
			else return false;
			editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			return true;
		},
	});
	bindMessengerDocument();
	return { dom, editor, button };
}

async function command(text = "Hi there") {
	const snapshot = await messengerChatAdapter.readConversation();
	return { commandId: crypto.randomUUID(), chatId: snapshot.chatId, expectedRevision: snapshot.revision, text };
}

function appendMessage(text: string, direction: "incoming" | "outgoing", status?: string) {
	const row = document.createElement("div");
	row.setAttribute("role", "row");
	row.setAttribute("data-message-direction", direction);
	if (status) row.setAttribute("data-message-status", status);
	const message = document.createElement("span");
	message.setAttribute("dir", "auto");
	message.textContent = text;
	row.append(message);
	document.querySelector('[data-scope="messages_table"]')!.append(row);
}

test("sends once only after authorization and confirms an appended outgoing message", async () => {
	const { dom, editor, button } = setup();
	let clicks = 0;
	button.addEventListener("click", () => {
		clicks++;
		assert.equal(editor.textContent, "Hi there");
		editor.textContent = "";
		appendMessage("Hi there", "outgoing", "sent");
	});
	const send = await command();
	let authorizations = 0;
	const authorize = async () => {
		authorizations++;
		return true;
	};
	const first = messengerChatAdapter.sendReply(send, authorize);
	const repeated = messengerChatAdapter.sendReply(send, authorize);
	assert.equal(await first, "sent");
	assert.equal(await repeated, "sent");
	assert.equal(await messengerChatAdapter.sendReply(send, authorize), "sent");
	assert.equal(clicks, 1);
	assert.equal(authorizations, 1);
	dom.window.close();
});

test("prepares a send without relying on a zero-delay background timer", async () => {
	const { dom, editor, button } = setup();
	button.addEventListener("click", () => {
		editor.textContent = "";
		appendMessage("Hi there", "outgoing", "sent");
	});
	const send = await command();
	const original = globalThis.setTimeout;
	globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
		if (timeout === 0) throw new Error("A background timer was used to prepare a send");
		return original(handler as (...args: unknown[]) => void, timeout, ...args);
	}) as typeof setTimeout;
	try {
		assert.equal(await messengerChatAdapter.sendReply(send, async () => true), "sent");
	} finally {
		globalThis.setTimeout = original;
		dom.window.close();
	}
});

test("does not treat a CSS-hidden status as send confirmation", async () => {
	for (const hiddenStyle of ["visibility: hidden", "opacity: 0"]) {
		const { dom, editor, button } = setup();
		let status: HTMLElement | null = null;
		button.addEventListener("click", () => {
			editor.textContent = "";
			appendMessage("Hi there", "outgoing");
			const wrapper = document.createElement("span");
			wrapper.setAttribute("style", hiddenStyle);
			status = document.createElement("span");
			status.setAttribute("role", "status");
			status.setAttribute("aria-label", "Sent");
			wrapper.append(status);
			document.querySelector('[data-scope="messages_table"] [role="row"]:last-child')!.append(wrapper);
		});
		let settled = false;
		const pending = messengerChatAdapter.sendReply(await command(), async () => true);
		void pending.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(settled, false);
		assert.ok(status);
		(status as HTMLElement).parentElement!.removeAttribute("style");
		assert.equal(await pending, "sent");
		dom.window.close();
	}
});

test("does not overwrite an existing draft or use an ambiguous composer", async () => {
	const { dom, editor, button } = setup();
	let clicks = 0;
	let authorizations = 0;
	button.addEventListener("click", () => clicks++);
	const authorize = async () => {
		authorizations++;
		return true;
	};
	const send = await command();
	editor.textContent = "User draft";
	assert.equal(await messengerChatAdapter.sendReply(send, authorize), "rejected");
	assert.equal(editor.textContent, "User draft");
	editor.textContent = "";
	const second = await command();
	editor.insertAdjacentHTML("afterend", '<div contenteditable="true" role="textbox" aria-label="Message"></div>');
	assert.equal(await messengerChatAdapter.sendReply(second, authorize), "rejected");
	assert.equal(clicks, 0);
	assert.equal(authorizations, 0);
	dom.window.close();
});

test("rejects stale snapshots, unsupported text, and a scrolled-away message list", async () => {
	const { dom, button } = setup();
	let clicks = 0;
	button.addEventListener("click", () => clicks++);
	const stale = await command();
	appendMessage("New message", "incoming");
	assert.equal(await messengerChatAdapter.sendReply(stale, async () => true), "rejected");
	const multiline = await command("one\ntwo");
	assert.equal(await messengerChatAdapter.sendReply(multiline, async () => true), "rejected");
	const scrolled = await command();
	const jump = document.createElement("button");
	jump.setAttribute("aria-label", "Scroll to bottom");
	document.querySelector("main")!.append(jump);
	assert.equal(await messengerChatAdapter.sendReply(scrolled, async () => true), "rejected");
	assert.equal(clicks, 0);
	dom.window.close();
});

test("does not dispatch after authorization is denied or local control changes", async () => {
	const { dom, editor, button } = setup();
	let clicks = 0;
	button.addEventListener("click", () => clicks++);
	const denied = await command();
	assert.equal(await messengerChatAdapter.sendReply(denied, async () => false), "rejected");
	assert.equal(editor.textContent, "");
	const cancelled = await command();
	assert.equal(
		await messengerChatAdapter.sendReply(
			cancelled,
			async () => true,
			() => false,
		),
		"rejected",
	);
	assert.equal(editor.textContent, "");
	assert.equal(clicks, 0);
	dom.window.close();
});

test("does not focus or insert a draft for an already invalid command", async () => {
	const { dom, editor } = setup();
	const send = await command();
	let focusEvents = 0;
	let authorizations = 0;
	editor.addEventListener("focus", () => focusEvents++);
	assert.equal(
		await messengerChatAdapter.sendReply(
			send,
			async () => {
				authorizations++;
				return true;
			},
			() => false,
		),
		"rejected",
	);
	assert.equal(focusEvents, 0);
	assert.equal(authorizations, 0);
	assert.equal(editor.textContent, "");
	dom.window.close();
});

test("rechecks local control after focus and before inserting a draft", async () => {
	const { dom, editor } = setup();
	const send = await command();
	let current = true;
	let authorizations = 0;
	editor.addEventListener("focus", () => {
		current = false;
	});
	assert.equal(
		await messengerChatAdapter.sendReply(
			send,
			async () => {
				authorizations++;
				return true;
			},
			() => current,
		),
		"rejected",
	);
	assert.equal(authorizations, 0);
	assert.equal(editor.textContent, "");
	dom.window.close();
});

test("rechecks the conversation and chat synchronously after authorization", async () => {
	const { dom, editor, button } = setup();
	let clicks = 0;
	button.addEventListener("click", () => clicks++);
	const send = await command();
	assert.equal(
		await messengerChatAdapter.sendReply(send, async () => {
			appendMessage("New message", "incoming");
			return true;
		}),
		"rejected",
	);
	assert.equal(editor.textContent, "");
	const next = await command();
	assert.equal(
		await messengerChatAdapter.sendReply(next, async () => {
			dom.window.history.pushState({}, "", "/t/456");
			return true;
		}),
		"rejected",
	);
	assert.equal(clicks, 0);
	dom.window.close();
});

test("preserves a user edit during authorization and reports it as uncertain", async () => {
	const { dom, editor, button } = setup();
	let clicks = 0;
	button.addEventListener("click", () => clicks++);
	const send = await command();
	assert.equal(
		await messengerChatAdapter.sendReply(send, async () => {
			editor.textContent = "User changed this";
			editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			return true;
		}),
		"uncertain",
	);
	assert.equal(editor.textContent, "User changed this");
	assert.equal(clicks, 0);
	dom.window.close();
});

test("reports an uncleared draft as uncertain when the editor loses focus", async () => {
	const { dom, editor, button } = setup();
	const send = await command();
	assert.equal(
		await messengerChatAdapter.sendReply(send, async () => {
			button.focus();
			return false;
		}),
		"uncertain",
	);
	assert.equal(editor.textContent, "Hi there");
	dom.window.close();
});

test("reports an uncleared draft as uncertain when Lexical ignores delete", async () => {
	const { dom, editor } = setup();
	const send = await command();
	Object.defineProperty(document, "execCommand", {
		configurable: true,
		value: (action: string, _showUi: boolean, text?: string) => {
			if (action === "insertText") editor.textContent = text ?? "";
			// Simulate a successful-looking delete that does not modify Lexical.
			return true;
		},
	});
	assert.equal(await messengerChatAdapter.sendReply(send, async () => false), "uncertain");
	assert.equal(editor.textContent, "Hi there");
	dom.window.close();
});

test("does not treat an optimistic bubble as confirmation or retry it", async () => {
	const { dom, editor, button } = setup();
	let clicks = 0;
	button.addEventListener("click", () => {
		clicks++;
		editor.textContent = "";
		appendMessage("Hi there", "outgoing", "pending");
	});
	const send = await command();
	assert.equal(await messengerChatAdapter.sendReply(send, async () => true), "uncertain");
	assert.equal(await messengerChatAdapter.sendReply(send, async () => true), "uncertain");
	assert.equal(clicks, 1);
	dom.window.close();
});
