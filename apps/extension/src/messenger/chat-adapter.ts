import { isAnimatedPreview } from "./animated-preview";
import { isGroupIntro, isGroupSystemEvent } from "./group-events";
import type { ConversationMessage, ConversationSnapshot, SendReplyCommand, SendResult } from "@envoy/contracts";

export interface MessengerChatAdapter {
	readConversation(): Promise<ConversationSnapshot>;
	sendReply(command: SendReplyCommand, authorize: () => Promise<boolean>, isCurrent?: () => boolean): Promise<SendResult>;
}

export class ConversationUnavailableError extends Error {
	constructor(public readonly reason: "no-chat" | "not-ready" | "not-latest" | "unsupported" | "changed" | "navigated") {
		super(reason);
	}
}

interface DocumentBinding {
	document: Document;
	window: Window;
	path: string;
	navigated: boolean;
	observer: MutationObserver;
	onPopState: () => void;
	onNavigate: (event: Event) => void;
	navigation: EventTarget | undefined;
}

let documentBinding: DocumentBinding | undefined;

// Bind before any asynchronous read. The rendered message table does not expose
// a verified thread ID, so a document that has navigated must be reloaded.
export function bindMessengerDocument(): void {
	if (typeof document === "undefined" || typeof window === "undefined") return;
	if (documentBinding?.document === document) return;
	if (documentBinding) {
		documentBinding.observer.disconnect();
		documentBinding.window.removeEventListener("popstate", documentBinding.onPopState);
		documentBinding.navigation?.removeEventListener("navigate", documentBinding.onNavigate);
	}

	const currentWindow = window;
	const currentDocument = document;
	const path = currentWindow.location.pathname;
	const onPopState = () => {
		if (currentWindow.location.pathname !== path) binding.navigated = true;
	};
	const onNavigate = (event: Event) => {
		const destination = (event as Event & { destination?: { url?: string } }).destination?.url;
		try {
			if (destination && new URL(destination, currentWindow.location.href).pathname !== path) binding.navigated = true;
		} catch {
			binding.navigated = true;
		}
	};
	const observer = new MutationObserver(onPopState);
	const navigation = (currentWindow as Window & { navigation?: EventTarget }).navigation;
	const binding: DocumentBinding = {
		document: currentDocument,
		window: currentWindow,
		path,
		navigated: false,
		observer,
		onPopState,
		onNavigate,
		navigation,
	};
	documentBinding = binding;
	observer.observe(currentDocument, { childList: true, subtree: true });
	currentWindow.addEventListener("popstate", onPopState);
	navigation?.addEventListener("navigate", onNavigate);
}

function documentHasNavigated(): boolean {
	bindMessengerDocument();
	if (!documentBinding) return true;
	if (documentBinding.path !== location.pathname) documentBinding.navigated = true;
	return documentBinding.navigated;
}

bindMessengerDocument();

// These IDs describe rendered DOM nodes, not permanent Messenger message IDs.
const messageIds = new WeakMap<Element, string>();

function getChatId(): string | null {
	const match = location.pathname.match(/(?:^|\/)t\/([^/]+)\/?$/);
	return match?.[1] ?? null;
}

interface RenderedMessage {
	element: HTMLElement;
	boundary: Element | null;
	images: HTMLElement[];
	unsent: boolean;
	standaloneLike?: boolean;
}

// Messenger keeps an unsent message's bubble and replaces its text with a
// placeholder. The placeholder is not the sender's words. A real message that
// reads like one is treated the same way, which only stops the agent.
const unsentPlaceholder =
	/^(?:[^\n]{1,100} )?(?:unsent a message|cofn\S*(?: ?\(-[^)]*\))? wysłanie wiadomości)\.?$|^(?:this |ta )?(?:message|wiadomość) (?:was |została )?(?:unsent|removed|deleted|cofnięta|usunięta)\.?$|^usunięto wiadomość\.?$/i;
// A quote of a withdrawn message names its state instead of quoting it.
const unavailableQuote =
	/^(?:message unavailable|(?:the )?original message (?:was )?(?:unsent|removed|deleted)|wiadomość (?:jest )?niedostępna|oryginalna wiadomość została (?:cofnięta|usunięta))\.?$/i;

function normalizedText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

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
		if (!child.matches("div, span") || ![null, "presentation", "none"].includes(child.getAttribute("role")))
			return false;
		return [...child.childNodes].every(controlOrDecoration);
	}
	return [...element.childNodes].every(controlOrDecoration);
}

function isDeliveryStatus(element: HTMLElement, candidates: HTMLElement[]): boolean {
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

function getMessageMain(): HTMLElement {
	const mains = [...document.querySelectorAll<HTMLElement>('[role="main"]')].filter((main) =>
		main.querySelector('[data-scope="messages_table"]'),
	);
	if (mains.length !== 1) throw new ConversationUnavailableError("not-ready");
	return mains[0]!;
}

function getRenderedMessages(main = getMessageMain()): RenderedMessage[] {
	const candidates = main.querySelectorAll<HTMLElement>(
		'[data-scope="messages_table"][dir="auto"], [data-scope="messages_table"] [dir="auto"]',
	);
	const textCandidates = [...candidates].filter((element) => {
		const scope = element.closest('[data-scope="messages_table"]');
		if (scope && (isGroupIntro(scope) || isTypingStatus(scope))) return false;
		if (
			element.closest(
				'button, [role="button"], [contenteditable="true"], [aria-hidden="true"], h1, h2, h3, h4, h5, h6, [role="heading"]',
			)
		)
			return false;
		if (isControlWrapper(element)) return false;
		const photoLink = element.closest<HTMLAnchorElement>("a[href]");
		if (photoLink && isMessengerPhotoLink(photoLink)) return false;
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
	const textElements = textCandidates.filter((element) => !isDeliveryStatus(element, textCandidates));
	const messages: RenderedMessage[] = textElements.map((element) => ({
		element,
		boundary: messageBoundary(element),
		images: [],
		unsent: unsentPlaceholder.test(normalizedText(element.textContent)),
	}));

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
	for (const image of images) {
		const boundary = messageBoundary(image);
		const textMatches = messages.filter(
			(message) => message.boundary === boundary && textElements.includes(message.element),
		);
		if (boundary && textMatches.length === 1) {
			textMatches[0]!.images.push(image);
			continue;
		}
		const imageMessage =
			boundary && textMatches.length === 0
				? messages.find((message) => message.boundary === boundary && !textElements.includes(message.element))
				: undefined;
		if (imageMessage) imageMessage.images.push(image);
		else messages.push({ element: image, boundary, images: [image], unsent: false });
	}
	// The placeholder may be plain text outside a directional text element.
	for (const element of main.querySelectorAll<HTMLElement>(
		'[data-scope="messages_table"] div, [data-scope="messages_table"] span',
	)) {
		const scope = element.closest('[data-scope="messages_table"]');
		if (
			(scope && (isGroupIntro(scope) || isTypingStatus(scope))) ||
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
		messages.push({ element, boundary: messageBoundary(element), images: [], unsent: true });
	}
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
		if (messages.some((message) => message.boundary === boundary)) throw new ConversationUnavailableError("unsupported");
		messages.push({ element: like, boundary, images: [], unsent: false, standaloneLike: true });
	}
	const ordered = messages.sort((a, b) => {
		if (a.element === b.element) return 0;
		return a.element.compareDocumentPosition(b.element) & 4 ? -1 : 1;
	});
	if (hasUnrecognizedContent(main, ordered)) throw new ConversationUnavailableError("unsupported");
	return ordered;
}

// A live typing announcement is status UI, not a message. It arrives in a
// messages_table scope without message metadata and must never hide real
// messages, attachments, or ambiguous content. Match structure (a live region
// with only announcement text), never height alone or translated words.
function isLiveAnnouncement(element: Element): boolean {
	const value = element.getAttribute("aria-live")?.trim().toLowerCase();
	return value === "polite" || value === "assertive";
}

function isInsideScopeLive(element: Element, scope: Element): boolean {
	for (let current: Element | null = element; current; current = current.parentElement) {
		if (isLiveAnnouncement(current)) return true;
		if (current === scope) break;
	}
	return false;
}

function isTypingStatus(scope: Element): boolean {
	if (!scope.matches('[data-scope="messages_table"]')) return false;
	const metadata =
		"[data-message-id], [aria-roledescription], [data-message-direction], [data-message-type], [data-attachment-type]";
	if (scope.matches(metadata) || scope.querySelector(metadata)) return false;
	if (!isLiveAnnouncement(scope) && ![...scope.querySelectorAll("[aria-live]")].some(isLiveAnnouncement)) return false;
	if (
		scope.querySelector(
			'[role="row"], [role="article"], button, [role="button"], [role="toolbar"], a[href], img, svg, canvas, video, audio, object, embed, iframe, input, [contenteditable], h1, h2, h3, h4, h5, h6, [role="heading"], [role="img"], [aria-label], [alt]',
		)
	)
		return false;
	if (scope.matches("[aria-label], [alt]")) return false;
	for (const dir of scope.querySelectorAll("[dir]")) {
		if (!isInsideScopeLive(dir, scope)) return false;
	}
	if (scope.matches("[dir]") && !isLiveAnnouncement(scope)) return false;
	const stack: Node[] = [...scope.childNodes];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.nodeType === 3) {
			if (!node.nodeValue?.trim()) continue;
			const parent = node.parentNode as Element | null;
			if (!parent || !isInsideScopeLive(parent, scope)) return false;
			continue;
		}
		if (node.nodeType === 1) stack.push(...node.childNodes);
	}
	function statusOnly(node: Node): boolean {
		if (node.nodeType === 3) return true;
		if (node.nodeType !== 1) return true;
		const child = node as Element;
		if (!child.matches("div, span")) return false;
		if (![null, "presentation", "none", "status", "log"].includes(child.getAttribute("role"))) return false;
		return [...child.childNodes].every(statusOnly);
	}
	return [...scope.childNodes].every(statusOnly);
}

// Messenger gives date separators and a zero-height empty presentation wrapper
// beside the newest article a messages_table scope. Neither is a message.
function isMessageDecoration(element: HTMLElement): boolean {
	const date = element.querySelector('[data-scope="date_break"][aria-hidden="true"]');
	const empty =
		element.matches('[data-scope="messages_table"]') &&
		element.getBoundingClientRect().height === 0 &&
		element.children.length === 1 &&
		element.firstElementChild?.matches('div[role="presentation"]');
	if (!date && !empty) return false;
	const metadata =
		"[data-message-id], [aria-roledescription], [data-message-direction], [data-message-type], [data-attachment-type]";
	if (element.matches(metadata) || element.querySelector(metadata)) return false;
	if (!date && (element.matches("[aria-label], [dir]") || element.querySelector("[aria-label], [dir]"))) return false;
	function decoration(node: Node): boolean {
		if (node.nodeType === 3) return !node.nodeValue?.trim();
		if (node.nodeType !== 1) return true;
		const child = node as HTMLElement;
		if (child.matches('[data-scope="date_break"][aria-hidden="true"]')) return true;
		if (!child.matches("div, span") || ![null, "presentation", "none"].includes(child.getAttribute("role")))
			return false;
		return [...child.childNodes].every(decoration);
	}
	return [...element.childNodes].every(decoration);
}

function hasUnrecognizedContent(main: HTMLElement, rendered: RenderedMessage[]): boolean {
	const scopes = [...main.querySelectorAll<HTMLElement>('[data-scope="messages_table"]')].filter(
		(scope) => isVisible(scope) && !isMessageDecoration(scope) && !isGroupIntro(scope) && !isTypingStatus(scope),
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
		// A text caption does not make an adjacent voice, video, sticker, or file
		// readable by this text-only connector.
		const media = [
			scope,
			...scope.querySelectorAll<HTMLElement>(
				"video, audio, object, embed, iframe, a[download], [aria-label], img[alt], [data-message-type], [data-attachment-type]",
			),
		].filter((element) => isVisible(element) && !element.closest('[role="toolbar"]'));
		if (
			media.some((element) => {
				if (element.matches("video, audio, object, embed, iframe, a[download]")) return true;
				const preview = rendered
					.flatMap(({ images }) => images)
					.find((image) => isAnimatedPreview(image) && (image === element || image.contains(element)));
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
				const checkedMetadata = preview ? metadata.replace(/(?:^|\s)gif(?=$|[\s:.,])/gi, " ") : metadata;
				return /(?:^|\s)(?:sticker|voice(?: message)?|audio(?: message)?|video|gif|file attachment|naklejka|wiadomość głosowa|plik)(?:$|[\s:.,])/i.test(
					checkedMetadata,
				);
			})
		)
			return true;

		const rows = [...scope.querySelectorAll<HTMLElement>('[role="row"], [role="article"]')].filter(
			(row) => isVisible(row) && !row.closest('button, [role="button"], [role="toolbar"]'),
		);
		const leaves = rows.filter((row) => !rows.some((other) => other !== row && row.contains(other)));
		const candidates: HTMLElement[] = leaves.length ? leaves : [scope];
		if (candidates.some((candidate) => !rendered.some(({ element }) => candidate.contains(element)))) return true;
	}
	return false;
}

function isAtLatestMessages(main: HTMLElement, rendered: RenderedMessage[]): boolean {
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

function isMessengerPhotoLink(anchor: HTMLAnchorElement): boolean {
	try {
		const url = new URL(anchor.getAttribute("href") ?? "", location.href);
		return (
			url.protocol === "https:" &&
			/^(?:www\.)?(?:facebook|messenger)\.com$/i.test(url.hostname) &&
			/^\/messenger_media\/?$/.test(url.pathname)
		);
	} catch {
		return false;
	}
}

function messageId(element: Element): string {
	let id = messageIds.get(element);
	if (!id) {
		id = crypto.randomUUID();
		messageIds.set(element, id);
	}
	return id;
}

// A message scope can be nested inside a row or article. Use the nearest boundary
// so metadata is never borrowed from an adjacent message.
function messageBoundary(element: HTMLElement): Element | null {
	return element.closest('[data-scope="messages_table"], [role="row"], [role="article"]');
}

function findReplyButton(boundary: Element): HTMLElement | undefined {
	return [...boundary.querySelectorAll<HTMLElement>('button[aria-label], [role="button"][aria-label]')].find((element) => {
		const label = element.getAttribute("aria-label") ?? "";
		return (
			!element.closest('[role="toolbar"]') &&
			(/na któr[aą] odpowiadasz/i.test(label) || /(?:go to|jump to|view).*(?:repl|original message)/i.test(label))
		);
	});
}

function readReply(boundary: Element): ConversationSnapshot["messages"][number]["replyTo"] {
	const button = findReplyButton(boundary);
	if (!button) return null;
	const quote = button.querySelector<HTMLElement>('[dir="auto"]');
	const text = quote ? readInlineText(quote) : "";
	const context = boundary.querySelector<HTMLElement>('h4, [role="heading"]');
	const quoteText = normalizedText(quote?.textContent);
	return {
		text:
			!quote || unsentPlaceholder.test(quoteText) || unavailableQuote.test(quoteText)
				? null
				: text.trim()
					? text
					: null,
		context: context?.textContent?.trim() || null,
		attachments: getQuotedImages(button).map(imageAttachment),
	};
}

// Messenger can replace an emoji character with an inline image. Decode only
// emoji-only alt text; any other embedded media is unavailable to this agent.
// Segmenting prevents labels such as "photo 1" or "😀2" from being accepted.
const emojiSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function readEmojiAlt(image: Element): string | null {
	const alt = image.getAttribute("alt")?.trim() ?? "";
	if (!alt || alt.length > 128) return null;
	for (const { segment } of emojiSegmenter.segment(alt)) {
		if (
			!/^[\p{Extended_Pictographic}\p{Emoji_Component}]+$/u.test(segment) ||
			!/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(segment)
		) {
			return null;
		}
	}
	return alt;
}

function readInlineText(element: Element): string {
	let text = "";
	let blockBreakPending = false;
	function appendText(value: string): void {
		if (!value) return;
		if (blockBreakPending && text && !text.endsWith("\n")) text += "\n";
		blockBreakPending = false;
		text += value;
	}
	function append(node: Node): void {
		if (node.nodeType === 3) {
			appendText(node.nodeValue ?? "");
			return;
		}
		if (node.nodeType !== 1) return;
		const child = node as Element;
		if (child.matches("br")) {
			appendText("\n");
			return;
		}
		if (child.matches("img")) {
			const emoji = readEmojiAlt(child);
			if (!emoji) throw new ConversationUnavailableError("unsupported");
			appendText(emoji);
			return;
		}
		if (child.matches("svg, canvas, video, audio, object, embed, iframe")) {
			throw new ConversationUnavailableError("unsupported");
		}
		const display = window.getComputedStyle(child).display;
		// Atomic inline boxes keep their descendants' block boundaries local.
		// Preserve interior breaks without adding breaks around the box.
		if (["inline-block", "inline-flex", "inline-grid", "inline-table"].includes(display)) {
			appendText(readInlineText(child));
			return;
		}
		const block = ["block", "flow-root", "list-item", "flex", "grid", "table", "table-row", "table-caption"].includes(
			display,
		);
		// Defer implicit separators to avoid extra breaks from nested wrappers or
		// a trailing block. Explicit BRs still preserve consecutive blank lines.
		if (block) blockBreakPending = true;
		for (const nested of child.childNodes) append(nested);
		if (block) blockBreakPending = true;
	}
	for (const child of element.childNodes) append(child);
	return text;
}

function getQuotedImages(button: Element): HTMLImageElement[] {
	return [...button.querySelectorAll<HTMLImageElement>("img")].filter((image) => {
		const label = `${image.alt} ${image.getAttribute("aria-label") ?? ""}`;
		return !image.closest('[dir="auto"], [aria-hidden="true"]') && /photo|image|zdjęci|obraz/i.test(label);
	});
}

// A viewer link identifies the attachment; the image element supplies the
// direct URL when one is rendered. No network request is needed to read it.
function imageAttachment(image: HTMLImageElement | null): { type: "image"; url: string | null; description: null } {
	const sources = image ? [image.currentSrc, image.getAttribute("src")] : [];
	for (const source of sources) {
		if (!source?.trim()) continue;
		try {
			const url = new URL(source, location.href);
			if (url.protocol === "http:" || url.protocol === "https:") {
				return { type: "image", url: url.href, description: null };
			}
		} catch {
			// Ignore malformed or unavailable sources.
		}
	}
	return { type: "image", url: null, description: null };
}

function readReactions(boundary: Element): ConversationSnapshot["messages"][number]["reactions"] {
	return [...boundary.querySelectorAll<HTMLElement>('button[aria-label], [role="button"][aria-label]')]
		.filter((element) => {
			const label = element.getAttribute("aria-label") ?? "";
			return !element.closest('[role="toolbar"]') && /reakcj|zareagowa|reaction|reacted/i.test(label);
		})
		.map((element) => {
			const label = element.getAttribute("aria-label")!.trim();
			const emojis = [...element.querySelectorAll<HTMLImageElement>("img[alt]")]
				.map((image) => image.alt.trim())
				.filter((alt) => /\p{Extended_Pictographic}/u.test(alt));
			const count = label.match(/(?:^|\s)(\d+)(?=\s|$)/)?.[1];
			return { label, emojis, count: count ? Number(count) : null };
		});
}

// Only metadata that explicitly describes the sender is used here. Message
// alignment, color, and an arbitrary person's name do not establish who sent it.
function readLabeledMessage(boundary: Element): { sender: string; text: string } | null {
	// This is Messenger's per-message accessibility label, not message text or
	// a group heading. Consecutive bubbles often have no sender heading at all.
	if (!boundary.matches('[data-scope="messages_table"][data-message-id]')) return null;
	if (!/^(?:message|wiadomość)$/i.test(boundary.getAttribute("aria-roledescription") ?? "")) return null;
	const label = boundary.getAttribute("aria-label") ?? "";
	const match = label.match(/^(?:O|At) [^\n]*?\d{1,2}:\d{2}(?:\s?[AP]M)?, ([^:\n]{1,100})(?::(?:\s|$)|$)/i);
	if (!match) return null;
	const sender = match[1]?.trim();
	return sender ? { sender, text: label.slice(match[0].length).trim() } : null;
}

function readLabeledSender(boundary: Element): string | null {
	return readLabeledMessage(boundary)?.sender ?? null;
}

function readDirection(boundary: Element): ConversationMessage["direction"] {
	if (isGroupSystemEvent(boundary)) return "system";
	const directions = new Set<ConversationMessage["direction"]>();
	const explicit = boundary.getAttribute("data-message-direction");
	if (explicit === "incoming" || explicit === "outgoing") directions.add(explicit);
	const sender = readLabeledSender(boundary);
	if (sender) directions.add(/^(?:you|ty)$/i.test(sender) ? "outgoing" : "incoming");

	const labels = [
		boundary.getAttribute("aria-label") ?? "",
		...[...boundary.querySelectorAll<HTMLElement>('h4, [role="heading"]')].map((heading) => heading.textContent ?? ""),
	];
	for (const label of labels.map((value) => value.trim())) {
		if (
			/^(?:you sent|sent by you|message sent by you|you replied to|wysłano przez ciebie|wiadomość wysłana przez ciebie|odpowiadasz .+)(?:\b|\s|[.:,]|$)/i.test(
				label,
			)
		) {
			directions.add("outgoing");
		}
		if (
			/^(?:message received from|received from|wiadomość otrzymana od|otrzymano od)\s+\S/i.test(label) ||
			/^[^\n]{1,100} replied to you(?:\b|\s|[.:,]|$)/i.test(label)
		) {
			directions.add("incoming");
		}
	}
	return directions.size === 1 ? [...directions][0]! : "unknown";
}

function readMessages(rendered: RenderedMessage[]): ConversationSnapshot["messages"] {
	const boundaries = rendered.map((message) => message.boundary);
	const texts = rendered.map(({ element, images, unsent, standaloneLike }) =>
		unsent || images.some((image) => image === element) ? "" : standaloneLike ? "👍" : readInlineText(element),
	);
	return rendered.map(({ element, boundary, images, unsent }, index) => {
		// A shared boundary cannot safely assign metadata to one message.
		const unique = boundary && boundaries.indexOf(boundary) === boundaries.lastIndexOf(boundary);
		// A fresh bubble can share its container with a rendered delivery status.
		// Attribute only the one text candidate named by the per-message label;
		// leave status candidates and ambiguous matches unknown.
		const labeled = !unique && boundary ? readLabeledMessage(boundary) : null;
		const matchesLabel =
			labeled?.text &&
			texts[index]!.trim() === labeled.text &&
			rendered.filter((message, i) => message.boundary === boundary && texts[i]!.trim() === labeled.text).length === 1;
		return {
			id: messageId(element),
			text: texts[index]!,
			direction: boundary && (unique || matchesLabel) ? readDirection(boundary) : "unknown",
			replyTo: unique ? readReply(boundary) : null,
			attachments: images.map((image) => imageAttachment(image.querySelector<HTMLImageElement>("img"))),
			reactions: unique ? readReactions(boundary) : [],
			unsent,
		};
	});
}

// Encrypted photo buttons have no viewer URL, and data/blob sources are not
// uploaded as attachments. They must still invalidate a reply when replaced.
function imageFingerprint(rendered: RenderedMessage[]): string[][] {
	return rendered.map(({ images, boundary }) => {
		const reply = boundary && findReplyButton(boundary);
		return [
			...images.flatMap((viewer) => {
				const image = viewer.querySelector<HTMLImageElement>("img");
				return [viewer.getAttribute("href") ?? "", image?.currentSrc || image?.getAttribute("src") || ""];
			}),
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
	const content = messages.map(({ text, direction, replyTo, attachments, reactions, unsent }) => ({
		text,
		direction,
		replyTo,
		attachments,
		reactions,
		unsent,
	}));
	const bytes = new TextEncoder().encode(JSON.stringify([chatId, content, imageState]));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface ConversationCapture {
	chatId: string;
	main: HTMLElement;
	rendered: RenderedMessage[];
	messages: ConversationSnapshot["messages"];
	imageState: string[][];
}

function captureConversation(): ConversationCapture {
	if (documentHasNavigated()) throw new ConversationUnavailableError("navigated");
	const chatId = getChatId();
	if (!chatId) throw new ConversationUnavailableError("no-chat");
	const main = getMessageMain();
	const rendered = getRenderedMessages(main);
	if (!isAtLatestMessages(main, rendered)) throw new ConversationUnavailableError("not-latest");
	return { chatId, main, rendered, messages: readMessages(rendered), imageState: imageFingerprint(rendered) };
}

function captureIsCurrent(capture: ConversationCapture): boolean {
	try {
		if (documentHasNavigated() || getChatId() !== capture.chatId || getMessageMain() !== capture.main) return false;
		const current = getRenderedMessages(capture.main);
		return (
			isAtLatestMessages(capture.main, current) &&
			current.length === capture.rendered.length &&
			capture.rendered.every((item, index) => current[index]?.element === item.element) &&
			JSON.stringify(readMessages(current)) === JSON.stringify(capture.messages) &&
			JSON.stringify(imageFingerprint(current)) === JSON.stringify(capture.imageState)
		);
	} catch {
		return false;
	}
}

function contentOf(messages: ConversationSnapshot["messages"]): unknown[] {
	return messages.map(({ text, direction, replyTo, attachments, reactions, unsent }) => ({
		text,
		direction,
		replyTo,
		attachments,
		reactions,
		unsent,
	}));
}

async function readCapturedConversation(): Promise<{ capture: ConversationCapture; snapshot: ConversationSnapshot }> {
	const capture = captureConversation();
	const revision = await revisionOf(capture.chatId, capture.messages, capture.imageState);
	if (!captureIsCurrent(capture)) {
		throw new ConversationUnavailableError(documentHasNavigated() ? "navigated" : "changed");
	}
	return { capture, snapshot: { chatId: capture.chatId, revision, messages: capture.messages } };
}

function isVisible(element: HTMLElement): boolean {
	if (!element.isConnected || element.closest('[aria-hidden="true"]') || element.getClientRects().length === 0)
		return false;
	// visibility:hidden retains layout rectangles, and opacity can hide an entire
	// subtree without changing a descendant's own computed opacity.
	for (let node: HTMLElement | null = element; node; node = node.parentElement) {
		const style = window.getComputedStyle(node);
		if (
			style.display === "none" ||
			style.visibility === "hidden" ||
			style.visibility === "collapse" ||
			style.opacity === "0"
		) {
			return false;
		}
	}
	return true;
}

function getComposer(main: HTMLElement): HTMLElement | null {
	const editors = [...main.querySelectorAll<HTMLElement>('[contenteditable="true"][role="textbox"]')].filter(isVisible);
	if (editors.length !== 1) return null;
	const editor = editors[0]!;
	const label = (editor.getAttribute("aria-label") ?? "").trim();
	const recognizedLabel =
		/^(?:message|message\.\.\.|message…|write a message|type a message|aa|wiadomość|napisz wiadomość|napisz wiadomość\.\.\.|napisz wiadomość…)$/i.test(
			label,
		);
	if (!recognizedLabel && editor.getAttribute("data-lexical-editor") !== "true") return null;
	if (editor.getAttribute("aria-disabled") === "true") return null;
	return editor;
}

function hasUnsupportedDraft(main: HTMLElement, editor: HTMLElement): boolean {
	if (editor.querySelector('img, video, audio, canvas, input, [contenteditable="false"]')) return true;
	return [...main.querySelectorAll<HTMLElement>('button[aria-label], [role="button"][aria-label]')].some(
		(button) =>
			isVisible(button) &&
			/^(?:remove|delete|cancel) (?:attachment|photo|image|file|reply)|^(?:usuń|anuluj) (?:załącznik|zdjęcie|plik|odpowiedź)/i.test(
				button.getAttribute("aria-label")?.trim() ?? "",
			),
	);
}

// The paper-plane path is the observed Messenger send icon. Unlike its title,
// the vector is shared across locales. Match its shape only inside the active
// composer's region; a Like, attachment, or message-toolbar button cannot send.
const sendIconPath =
	"M16.6915026,12.4744748 L3.50612381,13.2599618 C3.19218622,13.2599618 3.03521743,13.4170592 3.03521743,13.5741566";
function getSendButton(main: HTMLElement): HTMLElement | null {
	const editor = getComposer(main);
	const region = editor?.closest<HTMLElement>('[role="region"]');
	if (!region || !main.contains(region) || region.querySelector('[data-scope="messages_table"]')) return null;
	const buttons = [...region.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(
		(button) =>
			isVisible(button) &&
			[...button.querySelectorAll('svg[viewBox="0 0 24 24"] path')].some((path) =>
				(path.getAttribute("d") ?? "").replace(/\s+/g, "").startsWith(sendIconPath.replace(/\s+/g, "")),
			),
	);
	if (buttons.length !== 1) return null;
	const button = buttons[0]!;
	if (button.getAttribute("aria-disabled") === "true" || button.hasAttribute("disabled")) return null;
	return button;
}

function selectContents(editor: HTMLElement, collapse: boolean): boolean {
	const selection = window.getSelection();
	if (!selection) return false;
	const range = document.createRange();
	range.selectNodeContents(editor);
	if (collapse) range.collapse(false);
	selection.removeAllRanges();
	selection.addRange(range);
	return true;
}

function newlyAppendedOutgoing(before: ConversationSnapshot, after: ConversationSnapshot, text: string): boolean {
	if (before.chatId !== after.chatId || before.revision === after.revision) return false;
	// Messenger keeps a bounded rendered window. Appending a bubble can remove
	// its oldest rows; the remaining history must still be an unchanged suffix,
	// including the previous newest message. Never accept a wholly replaced view.
	const retained = after.messages.slice(0, -1);
	const removed = before.messages.length - retained.length;
	if (removed < 0 || (removed > 0 && retained.length === 0)) return false;
	if (JSON.stringify(contentOf(retained)) !== JSON.stringify(contentOf(before.messages.slice(removed)))) return false;
	const last = after.messages.at(-1);
	return Boolean(
		last &&
		last.direction === "outgoing" &&
		last.text === text &&
		last.attachments.length === 0 &&
		!before.messages.some((message) => message.id === last.id),
	);
}

function messengerMessageId(message: RenderedMessage | undefined): string {
	return message?.boundary?.getAttribute("data-message-id") ?? "";
}

function hasSentStatus(capture: ConversationCapture): boolean {
	const message = capture.rendered.at(-1);
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

function confirmSend(
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
				const id = messengerMessageId(capture.rendered.at(-1));
				if (
					!done &&
					!previousMessageIds.has(id) &&
					newlyAppendedOutgoing(before, snapshot, text) &&
					hasSentStatus(capture)
				)
					finish("sent");
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

// Lexical ignores execCommand (it fires no beforeinput) and reverts the native
// DOM edit. It accepts a beforeinput event instead, cancels it, and commits its
// own DOM update after dispatch returns. Report whether Lexical took the edit.
function editComposer(editor: HTMLElement, inputType: string, data: string | null = null): boolean {
	const event = new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true, composed: true });
	return !editor.dispatchEvent(event);
}

// Wait on DOM mutations rather than timers, which hidden tabs throttle. The
// timeout only bounds a composer that never reaches the expected state.
function waitForComposer(ready: () => boolean): Promise<boolean> {
	return new Promise((resolve) => {
		if (ready()) return resolve(true);
		let done = false;
		const finish = (result: boolean) => {
			if (done) return;
			done = true;
			observer.disconnect();
			clearTimeout(timeout);
			resolve(result);
		};
		const observer = new MutationObserver(() => {
			if (ready()) finish(true);
		});
		observer.observe(document.body, { childList: true, characterData: true, attributes: true, subtree: true });
		const timeout = setTimeout(() => finish(ready()), 2_000);
	});
}

async function performSend(
	command: SendReplyCommand,
	authorize: () => Promise<boolean>,
	isCurrent: () => boolean,
): Promise<SendResult> {
	let capture: ConversationCapture;
	let before: ConversationSnapshot;
	try {
		({ capture, snapshot: before } = await readCapturedConversation());
	} catch {
		return "rejected";
	}
	if (before.chatId !== command.chatId || before.revision !== command.expectedRevision) return "rejected";
	try {
		if (!isCurrent()) return "rejected";
	} catch {
		return "rejected";
	}
	const editor = getComposer(capture.main);
	if (!editor || editor.textContent !== "" || hasUnsupportedDraft(capture.main, editor)) return "rejected";

	let ownEdit = false;
	let changedByUser = false;
	const input = () => {
		if (!ownEdit) changedByUser = true;
	};
	editor.addEventListener("input", input);
	const removeListener = () => editor.removeEventListener("input", input);
	const clearOurDraft = async (): Promise<boolean> => {
		// If the user changed or left the editor, keep the draft intact.
		if (changedByUser || !editor.isConnected || editor.textContent !== command.text || document.activeElement !== editor)
			return false;
		if (!selectContents(editor, false)) return false;
		ownEdit = true;
		try {
			// Leave a draft alone if Messenger will not accept an editing command.
			if (!editComposer(editor, "deleteContentBackward")) return false;
		} catch {
			return false;
		} finally {
			ownEdit = false;
		}
		await waitForComposer(() => editor.textContent === "");
		return !changedByUser && editor.isConnected && editor.textContent === "";
	};
	const stopBeforeDispatch = async (): Promise<SendResult> => {
		const safeToClear = !changedByUser && editor.isConnected && editor.textContent === command.text;
		const cleared = safeToClear && (await clearOurDraft());
		removeListener();
		// A changed or retained draft may have been sent manually. Do not assume a
		// failed Lexical deletion cleared our text without checking the composer.
		return cleared ? "rejected" : "uncertain";
	};

	try {
		if (!isCurrent() || !captureIsCurrent(capture)) {
			removeListener();
			return "rejected";
		}
		editor.focus();
		if (document.activeElement !== editor || editor.textContent !== "" || !selectContents(editor, true)) {
			removeListener();
			return "rejected";
		}
		if (
			!isCurrent() ||
			!captureIsCurrent(capture) ||
			getComposer(capture.main) !== editor ||
			editor.textContent !== ""
		) {
			removeListener();
			return "rejected";
		}
		ownEdit = true;
		let inserted: boolean;
		try {
			inserted = editComposer(editor, "insertText", command.text);
		} finally {
			ownEdit = false;
		}
		if (inserted) await waitForComposer(() => editor.textContent === command.text);
		if (!inserted || changedByUser || editor.textContent !== command.text || hasUnsupportedDraft(capture.main, editor)) {
			return stopBeforeDispatch();
		}

		// Messenger renders its send control a few task turns after the draft.
		await waitForComposer(() => getSendButton(capture.main) !== null);
		if (!(await authorize())) return stopBeforeDispatch();

		// No await is allowed between the final authorization, local check, and click.
		const button = getSendButton(capture.main);
		if (
			!button ||
			changedByUser ||
			getComposer(capture.main) !== editor ||
			editor.textContent !== command.text ||
			hasUnsupportedDraft(capture.main, editor) ||
			!captureIsCurrent(capture) ||
			!isCurrent() ||
			getComposer(capture.main) !== editor ||
			editor.textContent !== command.text ||
			hasUnsupportedDraft(capture.main, editor) ||
			getSendButton(capture.main) !== button ||
			!captureIsCurrent(capture)
		) {
			return stopBeforeDispatch();
		}
		removeListener();
		// Save values before the click: Messenger can remount bubbles or replace
		// optimistic IDs while confirming. An old server ID is never a new send.
		const previousMessageIds = new Set(capture.rendered.map(messengerMessageId).filter(Boolean));
		// A thrown click handler does not prove the message was not dispatched.
		try {
			button.click();
		} catch {
			return "uncertain";
		}
		try {
			return await confirmSend(before, command.text, previousMessageIds);
		} catch {
			return "uncertain";
		}
	} catch {
		return stopBeforeDispatch();
	}
}

const attempts = new Map<string, { signature: string; result: Promise<SendResult> }>();
let sendInProgress = false;

export const messengerChatAdapter: MessengerChatAdapter = {
	async readConversation() {
		return (await readCapturedConversation()).snapshot;
	},
	sendReply(command, authorize, isCurrent = () => true) {
		if (
			!command.commandId ||
			!command.chatId ||
			!command.expectedRevision ||
			!command.text.trim() ||
			command.text.length > 4_000 ||
			/[\u0000-\u001f\u007f\u2028\u2029]/u.test(command.text)
		)
			return Promise.resolve("rejected");
		const signature = JSON.stringify([command.chatId, command.expectedRevision, command.text]);
		const previous = attempts.get(command.commandId);
		if (previous) return previous.signature === signature ? previous.result : Promise.resolve("rejected");
		if (sendInProgress) return Promise.resolve("rejected");
		sendInProgress = true;
		const result = performSend(command, authorize, isCurrent).finally(() => {
			sendInProgress = false;
		});
		attempts.set(command.commandId, { signature, result });
		return result;
	},
};
