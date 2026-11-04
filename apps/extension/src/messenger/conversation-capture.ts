import type { ConversationSnapshot } from "@envoy/contracts";
import { messageContent } from "@envoy/contracts";
import { getQuotedImages, imageSource, isGifViewer, videoSource } from "./attachments";
import { ConversationUnavailableError } from "./conversation-error";
import { documentHasNavigated, getChatId } from "./document-binding";
import { findReplyButton } from "./dom-queries";
import { attachInlineMedia } from "./inline-media";
import { isAtLatestMessages } from "./message-guards";
import { readMessages, readParticipantHeader } from "./message-reader";
import type { RenderedMessage } from "./rendered-message";
import { getMessageMain, getRenderedMessages } from "./rendered-messages";

// Encrypted photo buttons have no viewer URL, and data/blob sources are not
// uploaded as attachments. They must still invalidate a reply when replaced.
// Video blobs are likewise local-only, but a replaced clip must invalidate.
// A sticker's CSS URL can rotate across reloads and may be sensitive, so the
// stable graphic label feeds the revision instead. It is hashed, never sent.
// File hrefs are local-only too, but a replaced row must invalidate.
function imageFingerprint(rendered: RenderedMessage[]): string[][] {
	return rendered.map(({ images, videos, stickers, files, boundary }) => {
		const reply = boundary && findReplyButton(boundary);
		return [
			...images.flatMap((viewer) => {
				// A GIF link can render several images; track each so swapping
				// the animated render invalidates even when the others stay.
				const rendered = isGifViewer(viewer) ? [...viewer.querySelectorAll("img")] : [viewer.querySelector("img")];
				return [viewer.getAttribute("href") ?? "", ...rendered.map((image) => imageSource(image))];
			}),
			...videos.flatMap((viewer) => {
				const video = videoSource(viewer);
				return [video?.currentSrc || video?.getAttribute("src") || ""];
			}),
			...stickers.map((sticker) => sticker.getAttribute("aria-label") ?? ""),
			...files.map((file) => (file as HTMLAnchorElement).getAttribute("href") ?? ""),
			...(reply ? getQuotedImages(reply).map((image) => image.getAttribute("src") ?? "") : []),
		];
	});
}

async function revisionOf(
	chatId: string,
	messages: ConversationSnapshot["messages"],
	imageState: string[][],
): Promise<string> {
	// DOM-node IDs are temporary. Only the ordered message content contributes to the revision.
	// Inline bytes are transport: the rendered source already feeds the revision
	// through the fingerprint, so attachments enter stripped of media.
	const bytes = new TextEncoder().encode(JSON.stringify([chatId, messages.map(messageContent), imageState]));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface ConversationCapture {
	chatId: string;
	main: HTMLElement;
	rendered: RenderedMessage[];
	messages: ConversationSnapshot["messages"];
	imageState: string[][];
	// Attribution-only metadata. A rename must not invalidate a pending reply,
	// so participants stay out of the revision and the currency check below.
	participants: readonly string[];
}

function captureConversation(): ConversationCapture {
	if (documentHasNavigated()) throw new ConversationUnavailableError("navigated");
	const chatId = getChatId();
	if (!chatId) throw new ConversationUnavailableError("no-chat");
	const main = getMessageMain();
	const rendered = getRenderedMessages(main);
	if (!isAtLatestMessages(main, rendered)) throw new ConversationUnavailableError("not-latest");
	return {
		chatId,
		main,
		rendered,
		messages: readMessages(rendered),
		imageState: imageFingerprint(rendered),
		participants: readParticipantHeader(main),
	};
}

export function captureIsCurrent(capture: ConversationCapture): boolean {
	try {
		if (documentHasNavigated() || getChatId() !== capture.chatId || getMessageMain() !== capture.main) return false;
		const current = getRenderedMessages(capture.main);
		// Participants are deliberately not compared: a display-name change is
		// not a conversation change, and must neither invalidate a pending
		// reply nor fail this check. Sender labels are stripped the same way:
		// a loading rename must not fail this check either. Element identity
		// above already covers what node IDs would add.
		return (
			isAtLatestMessages(capture.main, current) &&
			current.length === capture.rendered.length &&
			capture.rendered.every((item, index) => current[index]?.element === item.element) &&
			JSON.stringify(readMessages(current).map(messageContent)) ===
				JSON.stringify(capture.messages.map(messageContent)) &&
			JSON.stringify(imageFingerprint(current)) === JSON.stringify(capture.imageState)
		);
	} catch {
		return false;
	}
}

export async function readCapturedConversation(): Promise<{ capture: ConversationCapture; snapshot: ConversationSnapshot }> {
	const capture = captureConversation();
	// Hashing starts synchronously so a change during the hash still rejects.
	// Media decoding runs alongside it; the currency check below covers both.
	const revisionPromise = revisionOf(capture.chatId, capture.messages, capture.imageState);
	await attachInlineMedia(capture.rendered, capture.messages);
	const revision = await revisionPromise;
	if (!captureIsCurrent(capture)) {
		throw new ConversationUnavailableError(documentHasNavigated() ? "navigated" : "changed");
	}
	return {
		capture,
		snapshot: {
			chatId: capture.chatId,
			revision,
			messages: capture.messages,
			participants: capture.participants,
		},
	};
}
