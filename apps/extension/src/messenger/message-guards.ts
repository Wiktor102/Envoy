import { GIF_WORD_SOURCE, isAnimatedPreview, isGifButton, isGifLabel } from "./animated-preview";
import { isThreadIntro } from "./group-events";
import { ATTACHMENT_WORDS, isGifLink } from "./attachments";
import { findReplyButton, hasPresentationRole, isVisible, MESSAGE_METADATA_SELECTOR } from "./dom-queries";
import { readLabeledMessage } from "./message-labels";
import type { RenderedMessage } from "./rendered-message";
import { isTypingStatus } from "./typing-status";

const MEDIA_WORD = new RegExp(`(?:^|\\s)(?:${ATTACHMENT_WORDS}|gif)(?:$|[\\s:.,])`, "i");

// Messenger gives date separators and a zero-height empty presentation wrapper
// beside the newest article a messages_table scope. Neither is a message.
export function isMessageDecoration(element: HTMLElement): boolean {
	const date = element.querySelector('[data-scope="date_break"][aria-hidden="true"]');
	const empty =
		element.matches('[data-scope="messages_table"]') &&
		element.getBoundingClientRect().height === 0 &&
		element.children.length === 1 &&
		element.firstElementChild?.matches('div[role="presentation"]');
	if (!date && !empty) return false;
	if (element.matches(MESSAGE_METADATA_SELECTOR) || element.querySelector(MESSAGE_METADATA_SELECTOR)) return false;
	if (!date && (element.matches("[aria-label], [dir]") || element.querySelector("[aria-label], [dir]"))) return false;
	function decoration(node: Node): boolean {
		if (node.nodeType === 3) return !node.nodeValue?.trim();
		if (node.nodeType !== 1) return true;
		const child = node as HTMLElement;
		if (child.matches('[data-scope="date_break"][aria-hidden="true"]')) return true;
		if (!child.matches("div, span") || !hasPresentationRole(child)) return false;
		return [...child.childNodes].every(decoration);
	}
	return [...element.childNodes].every(decoration);
}

function hasUnrecognizedMedia(scope: HTMLElement, rendered: RenderedMessage[]): boolean {
	// A text caption does not make an adjacent voice, video, sticker, or file
	// readable by this text-only connector. Recognized video viewers carry
	// their player UI with them, so exempt that subtree, as are recognized
	// sticker graphics and file rows.
	const recognizedMedia = rendered.flatMap(({ videos, stickers, files }) => [...videos, ...stickers, ...files]);
	const inRecognizedMedia = (element: Element) =>
		recognizedMedia.some((viewer) => viewer === element || viewer.contains(element));
	const media = [
		scope,
		...scope.querySelectorAll<HTMLElement>(
			"video, audio, object, embed, iframe, a[download], [aria-label], img[alt], [data-message-type], [data-attachment-type]",
		),
	].filter((element) => isVisible(element) && !element.closest('[role="toolbar"]'));
	// Quote previews may wrap their image in labelled GIF chrome. The gif
	// word alone never trips inside a quote; any other media word still does.
	const reply = findReplyButton(scope);
	return media.some((element) => {
		if (inRecognizedMedia(element)) return false;
		// A quoted file preview carries no download row; a stray one
		// inside a quote stays text, never a reader failure.
		if (element.matches("a[download]") && (reply?.contains(element) ?? false)) return false;
		if (element.matches("video, audio, object, embed, iframe, a[download]")) return true;
		const preview = rendered
			.flatMap(({ images }) => images)
			.find(
				(image) =>
					(isAnimatedPreview(image) || isGifButton(image)) && (image === element || image.contains(element)),
			);
		const metadata = [
			// A per-message label contains the sender and message body, not
			// attachment metadata. Words such as "plik" can be ordinary text.
			readLabeledMessage(element) ? null : element.getAttribute("aria-label"),
			element.getAttribute("alt"),
			element.getAttribute("data-message-type"),
			element.getAttribute("data-attachment-type"),
		]
			.filter(Boolean)
			.join(" ");
		const giphyImage = rendered
			.flatMap(({ images }) => images)
			.some(
				(viewer) =>
					isGifLink(viewer) &&
					element.matches("img[alt]") &&
					viewer.contains(element) &&
					isGifLabel(element.getAttribute("alt") ?? ""),
			);
		const inQuote = reply?.contains(element) ?? false;
		const checkedMetadata =
			preview || giphyImage || inQuote ? metadata.replace(new RegExp(GIF_WORD_SOURCE, "gi"), " ") : metadata;
		return MEDIA_WORD.test(checkedMetadata);
	});
}

export function hasUnrecognizedContent(main: HTMLElement, rendered: RenderedMessage[]): boolean {
	const scopes = [...main.querySelectorAll<HTMLElement>('[data-scope="messages_table"]')].filter(
		(scope) => isVisible(scope) && !isMessageDecoration(scope) && !isThreadIntro(scope) && !isTypingStatus(scope),
	);
	if (scopes.length === 0) return true;
	// A message row may be adjacent to, rather than inside, a recognized scope.
	// With no stable thread DOM contract, an unmapped visible row is unsafe.
	const allRows = [...main.querySelectorAll<HTMLElement>('[role="row"], [role="article"]')].filter(
		(row) => isVisible(row) && !isMessageDecoration(row) && !row.closest('button, [role="button"], [role="toolbar"]'),
	);
	const leafRows = allRows.filter((row) => !allRows.some((other) => other !== row && row.contains(other)));
	if (leafRows.some((row) => !rendered.some(({ element }) => row.contains(element)))) return true;
	for (const scope of scopes) {
		if (hasUnrecognizedMedia(scope, rendered)) return true;

		const rows = [...scope.querySelectorAll<HTMLElement>('[role="row"], [role="article"]')].filter(
			(row) => isVisible(row) && !row.closest('button, [role="button"], [role="toolbar"]'),
		);
		const leaves = rows.filter((row) => !rows.some((other) => other !== row && row.contains(other)));
		const candidates: HTMLElement[] = leaves.length ? leaves : [scope];
		if (candidates.some((candidate) => !rendered.some(({ element }) => candidate.contains(element)))) return true;
	}
	return false;
}

export function isAtLatestMessages(main: HTMLElement, rendered: RenderedMessage[]): boolean {
	// An explicit jump-to-latest control is stronger evidence than scroll geometry.
	const jumpToLatest = [...main.querySelectorAll<HTMLElement>('button[aria-label], [role="button"][aria-label]')].some(
		(button) =>
			isVisible(button) &&
			/^(?:scroll to bottom|jump to (?:the )?(?:latest|newest|most recent)(?: messages?)?|przewiń do (?:najnowszych wiadomości|dołu))(?:[.!…]|$)/i.test(
				button.getAttribute("aria-label")?.trim() ?? "",
			),
	);
	if (jumpToLatest) return false;

	const first = rendered[0]?.element ?? main.querySelector<HTMLElement>('[data-scope="messages_table"]');
	const last = rendered.at(-1)?.element ?? first;
	if (!first || !last) return false;
	let measured = false;
	// Only inspect scroll containers shared by the first and last loaded message.
	// At least one must expose usable geometry; absence of a jump control does
	// not prove that the latest messages have loaded.
	for (let node: HTMLElement | null = first; node && main.contains(node); node = node.parentElement) {
		if (!node.contains(last)) continue;
		const overflow = window.getComputedStyle(node).overflowY;
		if (overflow !== "auto" && overflow !== "scroll") continue;
		if (node.clientHeight <= 0 || node.scrollHeight < node.clientHeight) return false;
		measured = true;
		if (node.scrollTop + node.clientHeight < node.scrollHeight - 2) return false;
	}
	return measured;
}
