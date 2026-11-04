import { isAnimatedPreview, isGifButton } from "./animated-preview";
import { isThreadIntro } from "./group-events";
import { ConversationUnavailableError } from "./conversation-error";
import {
	findReplyButton,
	hasPresentationRole,
	isMessengerPhotoLink,
	isVisible,
	messageBoundary,
	normalizedText,
} from "./dom-queries";
import { readInlineText } from "./inline-text";
import { collectFileViewers, collectStickerViewers, collectVideoViewers } from "./media-viewers";
import { hasUnrecognizedContent } from "./message-guards";
import { readLabeledMessage, readLabeledSender, unsentPlaceholder } from "./message-labels";
import { renderedMessage, type RenderedMessage } from "./rendered-message";
import { isTypingStatus } from "./typing-status";

function isControlWrapper(element: HTMLElement): boolean {
	if (!element.querySelector('button, [role="button"]')) return false;
	// Messenger's edit control sits inside a directional span, so checking
	// ancestors alone misses it. Ignore only wrappers made entirely of controls
	// and whitespace; keep mixed text or media for the reader to validate.
	function controlOrDecoration(node: Node): boolean {
		if (node.nodeType === 3) return !node.nodeValue?.trim();
		if (node.nodeType !== 1) return true;
		const child = node as Element;
		if (child.matches('button, [role="button"]')) return true;
		if (!child.matches("div, span") || !hasPresentationRole(child)) return false;
		return [...child.childNodes].every(controlOrDecoration);
	}
	return [...element.childNodes].every(controlOrDecoration);
}

export function isDeliveryStatus(element: HTMLElement, candidates: HTMLElement[]): boolean {
	const boundary = messageBoundary(element);
	if (!boundary) return false;
	const labeled = readLabeledMessage(boundary);
	if (!labeled?.text || !/^(?:you|ty)$/i.test(labeled.sender)) return false;
	// Messenger puts the visible elapsed delivery status in a presentation span
	// in the final direct child of the message scope, outside the bubble.
	const wrapper = element.parentElement;
	const footer = wrapper?.parentElement;
	if (
		!wrapper?.matches('span[role="presentation"]') ||
		!footer?.matches("div") ||
		footer.parentElement !== boundary ||
		boundary.lastElementChild !== footer
	)
		return false;
	const text = element.textContent?.trim() ?? "";
	if (!/^(?:wysłano|sent)(?:\s|$)/i.test(text) || text === labeled.text) return false;
	// Keep uncertain content. A separate bubble must match the message label,
	// so a real message whose text is itself "Wysłano" is never discarded.
	return candidates.some(
		(candidate) =>
			candidate !== element &&
			messageBoundary(candidate) === boundary &&
			readInlineText(candidate).trim() === labeled.text,
	);
}

export function getMessageMain(): HTMLElement {
	const mains = [...document.querySelectorAll<HTMLElement>('[role="main"]')].filter((main) =>
		main.querySelector('[data-scope="messages_table"]'),
	);
	if (mains.length !== 1) throw new ConversationUnavailableError("not-ready");
	return mains[0]!;
}

function collectTextElements(main: HTMLElement): HTMLElement[] {
	const candidates = main.querySelectorAll<HTMLElement>(
		'[data-scope="messages_table"][dir="auto"], [data-scope="messages_table"] [dir="auto"]',
	);
	const textCandidates = [...candidates].filter((element) => {
		const scope = element.closest('[data-scope="messages_table"]');
		if (scope && (isThreadIntro(scope) || isTypingStatus(scope))) return false;
		if (
			element.closest(
				'button, [role="button"], [contenteditable="true"], [aria-hidden="true"], h1, h2, h3, h4, h5, h6, [role="heading"]',
			)
		)
			return false;
		if (isControlWrapper(element)) return false;
		const photoLink = element.closest<HTMLAnchorElement>("a[href]");
		if (photoLink && isMessengerPhotoLink(photoLink)) return false;
		// A file row's label is part of the download control, not a message.
		// The row itself becomes a presence-only file attachment.
		if (element.closest("a[download]")) return false;
		// A nested directional span is part of the outer text, not a second message.
		const parent = element.parentElement?.closest('[dir="auto"]');
		if (parent && main.contains(parent) && parent.closest('[data-scope="messages_table"]')) return false;
		// Emoji can be rendered as inline images with no text nodes at all.
		return (
			(Boolean(element.textContent?.trim()) ||
				Boolean(element.querySelector("img, svg, canvas, video, audio, object, embed, iframe"))) &&
			isVisible(element)
		);
	});
	return textCandidates.filter((element) => !isDeliveryStatus(element, textCandidates));
}

function collectImageViewers(main: HTMLElement): HTMLElement[] {
	// Ordinary chats use viewer links; encrypted chats use photo buttons with
	// an explicitly labelled image. Neither requires opening the photo viewer.
	const images: HTMLElement[] = [
		...main.querySelectorAll<HTMLAnchorElement>('[data-scope="messages_table"] a[href]'),
	].filter(
		(anchor) =>
			!anchor.closest('[role="button"], button, [role="toolbar"], [aria-hidden="true"]') &&
			anchor.getClientRects().length > 0 &&
			isMessengerPhotoLink(anchor),
	);
	for (const image of main.querySelectorAll<HTMLImageElement>('[data-scope="messages_table"] img[alt]')) {
		if (!/^(?:open photo|open image|otwórz zdjęcie)$/i.test(image.alt.trim()) || !isVisible(image)) continue;
		const button = image.closest<HTMLElement>('button, [role="button"]');
		if (!button || button.closest('[role="toolbar"], [aria-hidden="true"]')) continue;
		const boundary = messageBoundary(button);
		if (!boundary?.matches('[data-scope="messages_table"][data-message-id]')) continue;
		if (findReplyButton(boundary)?.contains(button)) continue;
		if (!images.some((viewer) => viewer.contains(image))) images.push(button);
	}
	for (const button of main.querySelectorAll<HTMLElement>('[data-scope="messages_table"] [role="button"][tabindex]')) {
		if (!isAnimatedPreview(button) || !isVisible(button)) continue;
		const boundary = messageBoundary(button);
		if (!boundary || findReplyButton(boundary)?.contains(button)) continue;
		images.push(button);
	}
	for (const button of main.querySelectorAll<HTMLElement>('[data-scope="messages_table"] [role="button"]')) {
		if (!isGifButton(button) || !isVisible(button)) continue;
		const boundary = messageBoundary(button);
		if (!boundary || findReplyButton(boundary)?.contains(button)) continue;
		images.push(button);
	}
	return images;
}

function collectUnsentPlaceholders(main: HTMLElement): RenderedMessage[] {
	const placeholders: RenderedMessage[] = [];
	// The placeholder may be plain text outside a directional text element.
	for (const element of main.querySelectorAll<HTMLElement>(
		'[data-scope="messages_table"] div, [data-scope="messages_table"] span',
	)) {
		const scope = element.closest('[data-scope="messages_table"]');
		if (
			(scope && (isThreadIntro(scope) || isTypingStatus(scope))) ||
			element.closest(
				'[dir="auto"], button, [role="button"], [contenteditable="true"], [aria-hidden="true"], h1, h2, h3, h4, h5, h6, [role="heading"]',
			)
		)
			continue;
		const ownText = [...element.childNodes]
			.filter((node) => node.nodeType === 3)
			.map((node) => node.nodeValue)
			.join("");
		if (!unsentPlaceholder.test(normalizedText(ownText)) || !isVisible(element)) continue;
		placeholders.push(renderedMessage(element, { unsent: true }));
	}
	return placeholders;
}

function collectStandaloneLikes(main: HTMLElement): RenderedMessage[] {
	const likes: RenderedMessage[] = [];
	// Messenger renders its large Like as an accessible SVG rather than text.
	// Require the enclosing message label to identify the same emoji, and do not
	// treat reactions or a Like mixed with other content as a standalone message.
	for (const like of main.querySelectorAll<HTMLElement>(
		'[data-scope="messages_table"] [role="img"][aria-label="Like, thumbs up"]',
	)) {
		if (like.closest('button, [role="button"], [role="toolbar"], [aria-hidden="true"]') || !isVisible(like)) continue;
		const boundary = messageBoundary(like);
		if (
			!boundary?.matches('[data-scope="messages_table"][data-message-id]') ||
			!readLabeledSender(boundary) ||
			!/:\s*👍$/.test(boundary.getAttribute("aria-label") ?? "") ||
			!like.querySelector("svg") ||
			like.querySelector("img, video, audio, canvas, object, embed, iframe")
		)
			continue;
		likes.push(renderedMessage(like, { standaloneLike: true }));
	}
	return likes;
}

export function getRenderedMessages(main = getMessageMain()): RenderedMessage[] {
	const textElements = collectTextElements(main);
	const messages = textElements.map((element) =>
		renderedMessage(element, { unsent: unsentPlaceholder.test(normalizedText(element.textContent)) }),
	);

	// Media joins the single text bubble in its boundary, or that boundary's
	// media-only message. Otherwise it starts a message of its own.
	function placeMedia(kind: "images" | "videos" | "stickers" | "files", element: HTMLElement) {
		const boundary = messageBoundary(element);
		const textMatches = messages.filter(
			(message) => message.boundary === boundary && textElements.includes(message.element),
		);
		const target =
			boundary && textMatches.length === 1
				? textMatches[0]
				: boundary && textMatches.length === 0
					? messages.find((message) => message.boundary === boundary && !textElements.includes(message.element))
					: undefined;
		if (target) {
			target[kind].push(element);
			return;
		}
		const message = renderedMessage(element);
		message[kind].push(element);
		messages.push(message);
	}
	for (const image of collectImageViewers(main)) placeMedia("images", image);
	// An uploaded clip renders as a real <video> inside an expand button with
	// Video player UI. Neither data-message-type nor data-attachment-type was
	// observed. Require a video signal beyond a bare tag so unknown media
	// stays unsupported: playsinline, a src, or player UI in the viewer.
	for (const viewer of collectVideoViewers(main)) placeMedia("videos", viewer);
	// A built-in sticker is a bare div with role="img", a label ending in the
	// standalone word "sticker", and a CSS background image. No attachment
	// metadata was observed. Keep the shape narrow: unknown, quoted, toolbar,
	// or hidden graphics stay unsupported, and dimensions alone never qualify.
	for (const sticker of collectStickerViewers(main)) placeMedia("stickers", sticker);
	// A sent file renders as a download row. Capturing it keeps the reader
	// fail-closed without failing the whole snapshot; its bytes never leave.
	// Voice has no such row in the rendered DOM and stays out of scope.
	for (const file of collectFileViewers(main)) placeMedia("files", file);
	messages.push(...collectUnsentPlaceholders(main));
	for (const like of collectStandaloneLikes(main)) {
		if (messages.some((message) => message.boundary === like.boundary))
			throw new ConversationUnavailableError("unsupported");
		messages.push(like);
	}
	const ordered = messages.sort((a, b) => {
		if (a.element === b.element) return 0;
		return a.element.compareDocumentPosition(b.element) & 4 ? -1 : 1;
	});
	if (hasUnrecognizedContent(main, ordered)) throw new ConversationUnavailableError("unsupported");
	return ordered;
}
