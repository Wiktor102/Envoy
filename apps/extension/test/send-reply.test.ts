import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { bindMessengerDocument, messengerChatAdapter } from "../src/messenger/chat-adapter";

function setup() {
	const dom = new JSDOM(
		`<main role="main">
			<div data-scope="messages_table"><div role="row" data-message-direction="incoming"><span dir="auto">Hello</span></div></div>
			<div role="region"><div contenteditable="true" data-lexical-editor="true" role="textbox" aria-label="Message" tabindex="0"></div>
			<button aria-label="Send"><svg viewBox="0 0 24 24"><path d="M16.6915026,12.4744748 L3.50612381,13.2599618 C3.19218622,13.2599618 3.03521743,13.4170592 3.03521743,13.5741566"></path></svg></button></div>
		</main>`,
		{ url: "https://www.messenger.com/t/123" },
	);
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		location: dom.window.location,
		MutationObserver: dom.window.MutationObserver,
		InputEvent: dom.window.InputEvent,
	});
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	dom.window.HTMLElement.prototype.getClientRects = () => [1] as unknown as DOMRectList;
	const main = document.querySelector<HTMLElement>("main")!;
	main.style.overflowY = "auto";
	Object.defineProperty(main, "clientHeight", { configurable: true, value: 400 });
	Object.defineProperty(main, "scrollHeight", { configurable: true, value: 400 });
	const editor = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
	const button = document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
	// Like Lexical, cancel beforeinput edits and update the DOM after dispatch,
	// without an input event. Native execCommand edits would be reverted.
	const lexical = {
		accepts: (_inputType: string) => true,
		commit: queueMicrotask as (apply: () => void) => void,
	};
	editor.addEventListener("beforeinput", (event) => {
		const { inputType, data } = event as InputEvent;
		if (!lexical.accepts(inputType)) return;
		event.preventDefault();
		lexical.commit(() => {
			if (inputType === "insertText") editor.textContent += data ?? "";
			else if (inputType === "deleteContentBackward") editor.textContent = "";
		});
	});
	bindMessengerDocument();
	return { dom, editor, button, lexical };
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

test("confirms an acknowledged send when Messenger removes older rows from a full message window", async () => {
	for (const acknowledgement of ["footer", "receipt"]) {
		const { dom, editor, button } = setup();
		for (let index = 1; index < 15; index++) appendMessage(`Earlier message ${index}`, "incoming");
		const send = await command();
		let clicks = 0;
		button.addEventListener("click", () => {
			clicks++;
			editor.textContent = "";
			document.querySelector('[data-scope="messages_table"] [role="row"]')!.remove();
			const scope = document.createElement("div");
			scope.setAttribute("data-scope", "messages_table");
			scope.setAttribute(
				"data-message-id",
				acknowledgement === "footer" ? "7521931389265068106" : "100054118657081@msgr.7521931389265068106",
			);
			scope.setAttribute("aria-roledescription", "wiadomość");
			scope.setAttribute("aria-label", "O 14:49, Ty: Hi there");
			// Observed in Chrome: a nested directional bubble, followed by a
			// direct footer. The footer can be replaced by a read-receipt avatar.
			scope.innerHTML =
				'<h4 dir="auto">Wysłano</h4><div><span dir="auto"><div dir="auto">Hi there</div></span></div>' +
				(acknowledgement === "footer"
					? '<div><span role="presentation"><span dir="auto">Wysłano</span></span></div>'
					: '<div><span><img alt="Wyświetlona przez Alex"></span></div>');
			document.querySelector("main")!.append(scope);
		});
		assert.equal(await messengerChatAdapter.sendReply(send, async () => true), "sent", acknowledgement);
		assert.equal(await messengerChatAdapter.sendReply(send, async () => true), "sent", acknowledgement);
		assert.equal(clicks, 1);
		assert.equal((await messengerChatAdapter.readConversation()).messages.length, 15);
		dom.window.close();
	}
});

test("waits when a trimmed window has edits, reordered history, intervening messages, or no overlap", async () => {
	for (const change of ["edit", "reorder", "incoming", "extra-outgoing", "no-overlap", "pending"]) {
		const { dom, editor, button } = setup();
		for (let index = 1; index < 4; index++) appendMessage(`Earlier message ${index}`, "incoming");
		const scope = document.querySelector('[data-scope="messages_table"]')!;
		const original = [...scope.children];
		let outgoing: Element;
		let intervening: Element | undefined;
		button.addEventListener("click", () => {
			editor.textContent = "";
			original[0]!.remove();
			if (change === "edit") original[1]!.querySelector('[dir="auto"]')!.textContent = "Edited history";
			if (change === "reorder") scope.prepend(original[2]!);
			if (change === "incoming" || change === "extra-outgoing") {
				appendMessage("Another message", change === "incoming" ? "incoming" : "outgoing", "sent");
				intervening = scope.lastElementChild!;
			}
			if (change === "no-overlap") scope.replaceChildren();
			appendMessage("Hi there", "outgoing", change === "pending" ? "pending" : "sent");
			outgoing = scope.lastElementChild!;
		});
		let settled = false;
		const pending = messengerChatAdapter.sendReply(await command(), async () => true);
		void pending.then(() => (settled = true));
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(settled, false, change);
		// Restore a provable suffix without issuing another click.
		original[1]!.querySelector('[dir="auto"]')!.textContent = "Earlier message 1";
		intervening?.remove();
		scope.replaceChildren(...original.slice(1), outgoing!);
		outgoing!.setAttribute("data-message-status", "seen");
		assert.equal(await pending, "sent", change);
		dom.window.close();
	}
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

test("uses the composer send icon with arbitrary labels and never its Like button", async () => {
	for (const label of ["送信", "إرسال", "Enviar", ""]) {
		const { dom, editor, button } = setup();
		button.setAttribute("aria-label", label);
		editor.setAttribute("aria-label", label);
		const like = document.createElement("button");
		like.setAttribute("aria-label", "Wyślij polubienie");
		let likes = 0;
		like.addEventListener("click", () => likes++);
		document.querySelector('[role="region"]')!.append(like);
		button.addEventListener("click", () => {
			editor.textContent = "";
			appendMessage("Hi there", "outgoing", "sent");
		});
		assert.equal(await messengerChatAdapter.sendReply(await command(), async () => true), "sent");
		assert.equal(likes, 0);
		dom.window.close();
	}
});

test("rejects missing, ambiguous, disabled, or out-of-composer send icons", async () => {
	for (const change of ["missing", "ambiguous", "disabled", "outside"]) {
		const { dom, button } = setup();
		let clicks = 0;
		button.addEventListener("click", () => clicks++);
		if (change === "missing") button.querySelector("path")!.setAttribute("d", "M0 0 L1 1");
		if (change === "ambiguous") button.parentElement!.append(button.cloneNode(true));
		if (change === "disabled") button.disabled = true;
		if (change === "outside") document.querySelector("main")!.append(button);
		assert.equal(await messengerChatAdapter.sendReply(await command(), async () => true), "rejected");
		assert.equal(clicks, 0);
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
			status.setAttribute("data-message-status", "sent");
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

test("waits for a server message ID instead of translated sent headings", async () => {
	const { dom, editor, button } = setup();
	let message: HTMLElement | undefined;
	button.addEventListener("click", () => {
		editor.textContent = "";
		const scope = document.createElement("div");
		scope.setAttribute("data-scope", "messages_table");
		scope.setAttribute("data-message-id", "7520889721094971653");
		scope.setAttribute("aria-roledescription", "arbitrary locale");
		scope.setAttribute("data-message-direction", "outgoing");
		scope.innerHTML = '<h4>Wysłano</h4><span dir="auto">Hi there</span>';
		document.querySelector("main")!.append(scope);
		message = scope;
	});
	let settled = false;
	const pending = messengerChatAdapter.sendReply(await command(), async () => true);
	void pending.then(() => (settled = true));
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(settled, false);
	assert.ok(message);
	message.setAttribute("data-message-status", "pending");
	message.setAttribute("data-message-id", "100056210523203@msgr.7520889721094971653");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(settled, false);
	message.removeAttribute("data-message-status");
	assert.equal(await pending, "sent");
	dom.window.close();
});

test("confirms the visible sent footer captured in PR #9 without requiring a server ID", async () => {
	for (const [locale, sender, footerText] of [
		["wiadomość", "O 14:03, Ty", "Wysłano"],
		["message", "At 14:03, You", "Sent 1 minute ago"],
	]) {
		const { dom, editor, button } = setup();
		let clicks = 0;
		button.addEventListener("click", () => {
			clicks++;
			editor.textContent = "";
			const scope = document.createElement("div");
			scope.setAttribute("data-scope", "messages_table");
			scope.setAttribute("data-message-id", "7520889721094971653");
			scope.setAttribute("aria-roledescription", locale!);
			scope.setAttribute("aria-label", `${sender}: Hi there`);
			// Use the observed footer structure, not synthetic data-message-status.
			scope.innerHTML = `<h4 dir="auto">Wysłano</h4><div><span dir="auto">Hi there</span></div>
				<div><span role="presentation"><span dir="auto"><span>${footerText}</span></span></span></div>`;
			document.querySelector("main")!.append(scope);
		});
		const send = await command();
		assert.equal(await messengerChatAdapter.sendReply(send, async () => true), "sent");
		assert.equal(await messengerChatAdapter.sendReply(send, async () => true), "sent");
		assert.equal(clicks, 1);
		dom.window.close();
	}
});

test("waits for a visible footer on the sent bubble with no pending or failed status", async () => {
	for (const blocker of ["hidden", "transparent", "aria-hidden", "pending", "failed", "busy", "outside"]) {
		const { dom, editor, button } = setup();
		const scope = document.createElement("div");
		scope.setAttribute("data-scope", "messages_table");
		scope.setAttribute("data-message-id", "7520889721094971653");
		scope.setAttribute("aria-roledescription", "wiadomość");
		scope.setAttribute("aria-label", "O 14:03, Ty: Hi there");
		scope.innerHTML = '<div><span dir="auto">Hi there</span></div>';
		const footer = document.createElement("div");
		footer.innerHTML = '<span role="presentation"><span dir="auto"><span>Wysłano</span></span></span>';
		scope.append(footer);
		if (blocker === "hidden") footer.style.visibility = "hidden";
		if (blocker === "transparent") footer.style.opacity = "0";
		if (blocker === "aria-hidden") footer.setAttribute("aria-hidden", "true");
		if (blocker === "pending" || blocker === "failed") scope.setAttribute("data-message-status", blocker);
		if (blocker === "busy") scope.setAttribute("aria-busy", "true");
		button.addEventListener("click", () => {
			editor.textContent = "";
			document.querySelector("main")!.append(scope);
			if (blocker === "outside") document.querySelector("main")!.append(footer);
		});
		let settled = false;
		const pending = messengerChatAdapter.sendReply(await command(), async () => true);
		void pending.then(() => (settled = true));
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(settled, false, blocker);
		assert.equal(scope.isConnected, true);
		footer.removeAttribute("style");
		footer.removeAttribute("aria-hidden");
		scope.removeAttribute("data-message-status");
		scope.removeAttribute("aria-busy");
		if (blocker === "outside") scope.append(footer);
		assert.equal(await pending, "sent", blocker);
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
	const { dom, editor, lexical } = setup();
	const send = await command();
	lexical.accepts = (inputType) => inputType === "insertText";
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

test("waits for Lexical to commit a draft in a later task before sending", async () => {
	const { dom, editor, button, lexical } = setup();
	lexical.commit = (apply) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			apply();
		};
		channel.port2.postMessage(null);
	};
	let clicks = 0;
	button.addEventListener("click", () => {
		clicks++;
		assert.equal(editor.textContent, "Hi there");
		editor.textContent = "";
		appendMessage("Hi there", "outgoing", "sent");
	});
	assert.equal(await messengerChatAdapter.sendReply(await command(), async () => true), "sent");
	assert.equal(clicks, 1);
	dom.window.close();
});

test("confirms a deferred Lexical delete before reporting a cleared draft", async () => {
	const { dom, editor, button } = setup();
	let clicks = 0;
	button.addEventListener("click", () => clicks++);
	assert.equal(await messengerChatAdapter.sendReply(await command(), async () => false), "rejected");
	assert.equal(editor.textContent, "");
	assert.equal(clicks, 0);
	dom.window.close();
});

test("does not send when Lexical never commits the draft", async () => {
	const { dom, button, lexical } = setup();
	lexical.commit = () => {};
	let clicks = 0;
	button.addEventListener("click", () => clicks++);
	assert.equal(await messengerChatAdapter.sendReply(await command(), async () => true), "uncertain");
	assert.equal(clicks, 0);
	dom.window.close();
});

test("waits for Messenger to render the send control after the draft", async () => {
	const { dom, editor, button } = setup();
	const region = button.parentElement!;
	button.remove();
	// Messenger swaps the Like button for the send control after a later render.
	new dom.window.MutationObserver((_records, observer) => {
		if (editor.textContent === "") return;
		observer.disconnect();
		setTimeout(() => region.append(button), 20);
	}).observe(editor, { childList: true, characterData: true, subtree: true });
	let clicks = 0;
	button.addEventListener("click", () => {
		clicks++;
		editor.textContent = "";
		appendMessage("Hi there", "outgoing", "sent");
	});
	assert.equal(await messengerChatAdapter.sendReply(await command(), async () => true), "sent");
	assert.equal(clicks, 1);
	dom.window.close();
});
