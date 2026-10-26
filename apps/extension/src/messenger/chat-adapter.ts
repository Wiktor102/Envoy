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
	images: HTMLAnchorElement[];
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
	const ordered = messages.sort((a, b) => {
		if (a.element === b.element) return 0;
		return a.element.compareDocumentPosition(b.element) & 4 ? -1 : 1;
	});
	if (hasUnrecognizedContent(main, ordered)) throw new ConversationUnavailableError("unsupported");
	return ordered;
}

function hasUnrecognizedContent(main: HTMLElement, rendered: RenderedMessage[]): boolean {
	const scopes = [...main.querySelectorAll<HTMLElement>('[data-scope="messages_table"]')].filter(isVisible);
	if (scopes.length === 0) return true;
	// A message row may be adjacent to, rather than inside, a recognized scope.
	// With no stable thread DOM contract, an unmapped visible row is unsafe.
	const allRows = [...main.querySelectorAll<HTMLElement>('[role="row"], [role="article"]')].filter(
		(row) => isVisible(row) && !row.closest('button, [role="button"], [role="toolbar"]'),
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
				const metadata = [
					element.getAttribute("aria-label"),
					element.getAttribute("alt"),
					element.getAttribute("data-message-type"),
					element.getAttribute("data-attachment-type"),
				]
					.filter(Boolean)
					.join(" ");
				return /(?:^|\s)(?:sticker|voice(?: message)?|audio(?: message)?|video|gif|file attachment|naklejka|wiadomość głosowa|plik)(?:$|[\s:.,])/i.test(
					metadata,
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
			button.getClientRects().length > 0 &&
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

// Only metadata that explicitly describes the sender is used here. Message
// alignment, color, and an arbitrary person's name do not establish who sent it.
function readDirection(boundary: Element): ConversationMessage["direction"] {
	const directions = new Set<ConversationMessage["direction"]>();
	const explicit = boundary.getAttribute("data-message-direction");
	if (explicit === "incoming" || explicit === "outgoing") directions.add(explicit);

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
	return rendered.map(({ element, boundary, images }, index) => {
		// A shared boundary cannot safely assign metadata to one message.
		const unique = boundary && boundaries.indexOf(boundary) === boundaries.lastIndexOf(boundary);
		return {
			id: messageId(element),
			text: images.some((image) => image === element) ? "" : (element.textContent ?? ""),
			direction: unique ? readDirection(boundary) : "unknown",
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
	const content = messages.map(({ text, direction, replyTo, attachments, reactions }) => ({
		text,
		direction,
		replyTo,
		attachments,
		reactions,
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
	return messages.map(({ text, direction, replyTo, attachments, reactions }) => ({
		text,
		direction,
		replyTo,
		attachments,
		reactions,
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
	return element.isConnected && !element.closest('[aria-hidden="true"]') && element.getClientRects().length > 0;
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

function getSendButton(main: HTMLElement): HTMLElement | null {
	const buttons = [...main.querySelectorAll<HTMLElement>('button[aria-label], [role="button"][aria-label]')].filter(
		(button) =>
			isVisible(button) &&
			/^(?:send|send message|wyślij|wyślij wiadomość)$/i.test(button.getAttribute("aria-label")?.trim() ?? ""),
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
	if (after.messages.length !== before.messages.length + 1) return false;
	if (JSON.stringify(contentOf(after.messages.slice(0, -1))) !== JSON.stringify(contentOf(before.messages))) return false;
	const last = after.messages.at(-1);
	return Boolean(last && last.direction === "outgoing" && last.text === text && last.attachments.length === 0);
}

function hasSentStatus(capture: ConversationCapture): boolean {
	const boundary = capture.rendered.at(-1)?.boundary;
	if (!boundary) return false;
	const labels = [
		boundary.getAttribute("data-message-status") ?? "",
		boundary.getAttribute("aria-label") ?? "",
		...[...boundary.querySelectorAll<HTMLElement>('[aria-label], [role="status"]')]
			.filter(isVisible)
			.map(
				(element) =>
					element.getAttribute("aria-label") ??
					(element.getAttribute("role") === "status" ? element.textContent : "") ??
					"",
			),
	];
	if (
		labels.some((label) =>
			/^(?:sending(?:\.\.\.|…)?|pending|not sent|failed|could(?: not|n't) send|wysyłanie|nie wysłano|nieudane)$/i.test(
				label.trim(),
			),
		)
	)
		return false;
	return labels.some((label) =>
		/^(?:sent|delivered|seen|read|wysłano|dostarczono|wyświetlono|przeczytano)$/i.test(label.trim()),
	);
}

function confirmSend(before: ConversationSnapshot, text: string): Promise<SendResult> {
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
				if (!done && newlyAppendedOutgoing(before, snapshot, text) && hasSentStatus(capture)) finish("sent");
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
	const clearOurDraft = () => {
		// If the user changed or left the editor, keep the draft intact.
		if (changedByUser || !editor.isConnected || editor.textContent !== command.text || document.activeElement !== editor)
			return;
		if (!selectContents(editor, false)) return;
		ownEdit = true;
		try {
			document.execCommand("delete");
		} catch {
			// Leave a draft alone if Messenger will not accept an editing command.
		} finally {
			ownEdit = false;
		}
	};
	const stopBeforeDispatch = (): SendResult => {
		const safeToClear = !changedByUser && editor.isConnected && editor.textContent === command.text;
		if (safeToClear) clearOurDraft();
		removeListener();
		// If the injected draft disappeared or was edited, it may have been sent manually.
		return safeToClear ? "rejected" : "uncertain";
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
			inserted = document.execCommand("insertText", false, command.text);
		} finally {
			ownEdit = false;
		}
		if (!inserted || editor.textContent !== command.text || hasUnsupportedDraft(capture.main, editor)) {
			return stopBeforeDispatch();
		}

		// Messenger may render its send control in response to the input event.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
		// A thrown click handler does not prove the message was not dispatched.
		try {
			button.click();
		} catch {
			return "uncertain";
		}
		try {
			return await confirmSend(before, command.text);
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
