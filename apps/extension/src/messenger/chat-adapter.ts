import type { ConversationSnapshot, SendReplyCommand } from "@envoy/contracts";

export interface MessengerChatAdapter {
	readConversation(): Promise<ConversationSnapshot>;
	sendReply(command: SendReplyCommand): Promise<void>;
}

export class ConversationUnavailableError extends Error {
	constructor(public readonly reason: "no-chat" | "not-ready" | "changed") {
		super(reason);
	}
}

// These IDs describe rendered DOM nodes, not permanent Messenger message IDs.
const messageIds = new WeakMap<Element, string>();

function getChatId(): string | null {
	const match = location.pathname.match(/(?:^|\/)t\/([^/]+)\/?$/);
	return match?.[1] ?? null;
}

interface RenderedMessage {
	element: HTMLElement;
	boundary: Element | null;
	images: HTMLAnchorElement[];
}

function getRenderedMessages(): RenderedMessage[] {
	const mains = [...document.querySelectorAll<HTMLElement>('[role="main"]')].filter((main) =>
		main.querySelector('[data-scope="messages_table"]'),
	);
	if (mains.length !== 1) throw new ConversationUnavailableError("not-ready");

	const main = mains[0]!;
	const candidates = main.querySelectorAll<HTMLElement>(
		'[data-scope="messages_table"][dir="auto"], [data-scope="messages_table"] [dir="auto"]',
	);
	const textElements = [...candidates].filter((element) => {
		if (
			element.closest(
				'button, [role="button"], [contenteditable="true"], [aria-hidden="true"], h1, h2, h3, h4, h5, h6, [role="heading"]',
			)
		)
			return false;
		const photoLink = element.closest<HTMLAnchorElement>("a[href]");
		if (photoLink && isMessengerPhotoLink(photoLink)) return false;
		// A nested directional span is part of the outer text, not a second message.
		const parent = element.parentElement?.closest('[dir="auto"]');
		if (parent && main.contains(parent) && parent.closest('[data-scope="messages_table"]')) return false;
		return Boolean(element.textContent?.trim()) && element.getClientRects().length > 0;
	});
	const messages: RenderedMessage[] = textElements.map((element) => ({
		element,
		boundary: messageBoundary(element),
		images: [],
	}));

	// Messenger's photo viewer links identify image attachments without reading
	// unrelated images such as avatars, emoji, stickers, or reactions.
	const images = [...main.querySelectorAll<HTMLAnchorElement>('[data-scope="messages_table"] a[href]')].filter(
		(anchor) =>
			!anchor.closest('[role="button"], button, [role="toolbar"], [aria-hidden="true"]') &&
			anchor.getClientRects().length > 0 &&
			isMessengerPhotoLink(anchor),
	);
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
		else messages.push({ element: image, boundary, images: [image] });
	}
	return messages.sort((a, b) => {
		if (a.element === b.element) return 0;
		return a.element.compareDocumentPosition(b.element) & 4 ? -1 : 1;
	});
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
	const context = boundary.querySelector<HTMLElement>('h4, [role="heading"]');
	return {
		text: quote?.textContent?.trim() || null,
		context: context?.textContent?.trim() || null,
		attachments: getQuotedImages(button).map(imageAttachment),
	};
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

function readMessages(rendered: RenderedMessage[]): ConversationSnapshot["messages"] {
	const boundaries = rendered.map((message) => message.boundary);
	return rendered.map(({ element, boundary, images }, index) => {
		// A shared boundary cannot safely assign metadata to one message.
		const unique = boundary && boundaries.indexOf(boundary) === boundaries.lastIndexOf(boundary);
		return {
			id: messageId(element),
			text: images.some((image) => image === element) ? "" : (element.textContent ?? ""),
			replyTo: unique ? readReply(boundary) : null,
			attachments: images.map((image) => imageAttachment(image.querySelector<HTMLImageElement>("img"))),
			reactions: unique ? readReactions(boundary) : [],
		};
	});
}

// The digest also changes if a reused viewer link points to a new photo.
function imageFingerprint(rendered: RenderedMessage[]): string[][] {
	return rendered.map(({ images, boundary }) => {
		const reply = boundary && findReplyButton(boundary);
		return [
			...images.map((image) => image.getAttribute("href") ?? ""),
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
	const content = messages.map(({ text, replyTo, attachments, reactions }) => ({
		text,
		replyTo,
		attachments,
		reactions,
	}));
	const bytes = new TextEncoder().encode(JSON.stringify([chatId, content, imageState]));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const messengerChatAdapter: MessengerChatAdapter = {
	async readConversation() {
		const chatId = getChatId();
		if (!chatId) throw new ConversationUnavailableError("no-chat");
		const rendered = getRenderedMessages();
		const messages = readMessages(rendered);
		const imageState = imageFingerprint(rendered);
		const revision = await revisionOf(chatId, messages, imageState);
		const current = getRenderedMessages();
		if (
			getChatId() !== chatId ||
			current.length !== rendered.length ||
			rendered.some((item, index) => current[index]?.element !== item.element) ||
			JSON.stringify(readMessages(current)) !== JSON.stringify(messages) ||
			JSON.stringify(imageFingerprint(current)) !== JSON.stringify(imageState)
		) {
			throw new ConversationUnavailableError("changed");
		}
		return { chatId, revision, messages };
	},
	async sendReply(_command) {
		throw new Error("TODO: validated Messenger send");
	},
};
