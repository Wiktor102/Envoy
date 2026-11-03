import { createHash } from "node:crypto";
import type { ConversationMessage, ConversationSnapshot } from "@envoy/contracts";
import { forwardableMediaSlots, messageContent } from "@envoy/contracts";

export function latestMessage(snapshot: ConversationSnapshot): ConversationMessage | undefined {
	return [...snapshot.messages].reverse().find((message) => message.direction !== "system" || message.unsent);
}

export function readableLatest(messages: readonly ConversationMessage[], latest: ConversationMessage): boolean {
	// Only forwarded media reads as content. Anything else attached (files,
	// sourceless media), or media past the per-snapshot cap, still pauses for
	// the user.
	const slots = forwardableMediaSlots(messages);
	const index = messages.indexOf(latest);
	if (
		!latest.attachments.every(
			(attachment, position) =>
				(attachment.type === "image" ||
					attachment.type === "video" ||
					attachment.type === "gif" ||
					attachment.type === "sticker") &&
				slots[index]?.[position],
		)
	)
		return false;
	if (!latest.text.trim() && !latest.attachments.length) return false;
	const quote = latest.replyTo;
	return !quote || !(quote.attachments.length || !quote.text?.trim() || !quote.context?.trim());
}

export function semanticMessages(snapshot: ConversationSnapshot): string {
	// Sender labels are attribution-only metadata outside the revision. A
	// loading rename must not read as unverifiable content at the same revision.
	// Inline bytes are transport, not content: the same photo re-encoded must
	// not read as unverifiable either.
	return JSON.stringify(snapshot.messages.map(messageContent));
}

// Reactions and other cosmetic DOM changes must not trigger another reply to
// the same text after a send or cancellation.
export function textContext(snapshot: ConversationSnapshot): string {
	const contents = JSON.stringify(
		snapshot.messages.map(({ direction, text, replyTo, unsent }) => ({ direction, text, replyTo, unsent })),
	);
	return createHash("sha256").update(contents).digest("hex");
}
