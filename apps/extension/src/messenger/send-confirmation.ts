import type { ConversationSnapshot, SendResult } from "@envoy/contracts";
import { messageContent } from "@envoy/contracts";
import { type ConversationCapture, readCapturedConversation } from "./conversation-capture";
import { getChatId } from "./document-binding";
import { isVisible } from "./dom-queries";
import { messengerMessageId, type RenderedMessage } from "./rendered-message";
import { isDeliveryStatus } from "./rendered-messages";

function findOutgoingCandidateIndex(
	before: ConversationSnapshot,
	after: ConversationSnapshot,
	renderedAfter: RenderedMessage[],
	text: string,
	previousMessageIds: ReadonlySet<string>,
): number | null {
	if (before.chatId !== after.chatId || before.revision === after.revision) return null;
	const beforeIds = new Set(before.messages.map((message) => message.id));
	const candidates: number[] = [];
	for (let index = 0; index < after.messages.length; index++) {
		const candidate = after.messages[index]!;
		if (candidate.direction !== "outgoing" || candidate.text !== text || candidate.attachments.length !== 0) continue;
		if (beforeIds.has(candidate.id)) continue;
		if (previousMessageIds.has(messengerMessageId(renderedAfter[index]))) continue;
		// Messenger keeps a bounded rendered window. Appending a bubble can remove
		// its oldest rows; the history before the candidate must still be an
		// unchanged suffix, including the previous newest message when nothing was
		// trimmed. Never accept a wholly replaced view. Any readable trailing
		// suffix after the candidate (for example a newer incoming message) is allowed.
		const retained = after.messages.slice(0, index);
		const removed = before.messages.length - retained.length;
		if (removed < 0 || (removed > 0 && retained.length === 0)) continue;
		if (
			JSON.stringify(retained.map(messageContent)) !==
			JSON.stringify(before.messages.slice(removed).map(messageContent))
		)
			continue;
		candidates.push(index);
	}
	// Never confirm on text alone. Zero or ambiguous matches stay uncertain.
	return candidates.length === 1 ? candidates[0]! : null;
}

function hasSentStatusAt(capture: ConversationCapture, index: number): boolean {
	const message = capture.rendered[index];
	const boundary = message?.boundary;
	if (!message || !boundary) return false;
	// Machine status values are useful where a connector exposes them, but
	// translated headings and labels are not delivery acknowledgements.
	const statuses = [boundary, ...boundary.querySelectorAll<HTMLElement>("[data-message-status]")]
		.filter((element) => isVisible(element as HTMLElement))
		.map((element) => element.getAttribute("data-message-status"));
	if (statuses.some((status) => status && /^(?:sending|pending|failed|not-sent)$/.test(status))) return false;
	if (
		boundary.matches('[aria-busy="true"], [role="progressbar"]') ||
		boundary.querySelector('[aria-busy="true"], [role="progressbar"]')
	)
		return false;
	if (statuses.some((status) => status && /^(?:sent|delivered|seen|read)$/.test(status))) return true;
	// Reuse the reader's observed footer distinction. A visible sent footer
	// attached to this bubble is evidence even when its numeric ID stays put.
	// A translated heading or status-like message text alone is not enough.
	if (
		[...boundary.querySelectorAll<HTMLElement>('[dir="auto"]')].some(
			(element) => isVisible(element) && isDeliveryStatus(element, [message.element, element]),
		)
	)
		return true;
	// The live encrypted UI replaces its optimistic numeric ID with a qualified
	// @msgr ID when acknowledged. Regular threads use the server's mid.$ IDs.
	// Without a status, never confirm a numeric bubble just from its heading.
	const id = messengerMessageId(message);
	return (
		boundary.matches('[data-scope="messages_table"][aria-roledescription]') &&
		/^(?:\d+@msgr\.\d+|mid\.\$[\w-]+)$/.test(id)
	);
}

export function confirmSend(
	before: ConversationSnapshot,
	text: string,
	previousMessageIds: ReadonlySet<string>,
): Promise<SendResult> {
	return new Promise((resolve) => {
		let done = false;
		let checking = false;
		const finish = (result: SendResult) => {
			if (done) return;
			done = true;
			observer.disconnect();
			clearInterval(interval);
			clearTimeout(timeout);
			resolve(result);
		};
		const check = async () => {
			if (done || checking) return;
			if (getChatId() !== before.chatId) return finish("uncertain");
			checking = true;
			try {
				const { capture, snapshot } = await readCapturedConversation();
				const candidate = findOutgoingCandidateIndex(before, snapshot, capture.rendered, text, previousMessageIds);
				if (!done && candidate !== null && hasSentStatusAt(capture, candidate)) finish("sent");
			} catch {
				// A changing or incomplete view is not evidence that Messenger sent the message.
			} finally {
				checking = false;
			}
		};
		const observer = new MutationObserver(() => void check());
		observer.observe(document.body, { childList: true, characterData: true, attributes: true, subtree: true });
		const interval = setInterval(() => void check(), 200);
		const timeout = setTimeout(() => finish("uncertain"), 5_000);
		void check();
	});
}
