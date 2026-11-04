import { isThreadIntro } from "./group-events";
import { findReplyButton, isVisible, messageBoundary } from "./dom-queries";
import { isMessageDecoration } from "./message-guards";
import { isTypingStatus } from "./typing-status";

// Thread intros, typing status, and date decorations carry no attachments.
function inMessageScope(element: Element): boolean {
	const scope = element.closest<HTMLElement>('[data-scope="messages_table"]');
	if (!scope || isThreadIntro(scope) || isTypingStatus(scope)) return false;
	return !isMessageDecoration(scope);
}

export function collectVideoViewers(main: HTMLElement): HTMLElement[] {
	const viewers: HTMLElement[] = [];
	for (const video of main.querySelectorAll<HTMLVideoElement>('[data-scope="messages_table"] video')) {
		const element = video as HTMLElement;
		if (!isVisible(element) || element.closest('[role="toolbar"], [aria-hidden="true"]')) continue;
		if (!inMessageScope(element)) continue;
		const viewer = (video.closest('[role="button"], a[href]') as HTMLElement | null) ?? element;
		if (!viewer.isConnected || !isVisible(viewer) || viewer.closest('[role="toolbar"], [aria-hidden="true"]')) continue;
		const boundary = messageBoundary(viewer);
		if (!boundary?.matches('[data-scope="messages_table"][data-message-id]')) continue;
		if (findReplyButton(boundary)?.contains(viewer)) continue;
		// A bare <video> tag alone stays unsupported. Observed clips carry at
		// least one player signal: playsinline, a src, or player UI.
		const src = video.getAttribute("src") ?? video.currentSrc ?? "";
		const hasSignal =
			video.hasAttribute("playsinline") ||
			src.trim() !== "" ||
			viewer.querySelector("[data-instancekey], [role='group'], [role='button']") !== null;
		if (!hasSignal) continue;
		if (!viewers.some((existing) => existing === viewer || existing.contains(viewer) || viewer.contains(existing)))
			viewers.push(viewer);
	}
	return viewers;
}

export function collectStickerViewers(main: HTMLElement): HTMLElement[] {
	const stickers: HTMLElement[] = [];
	for (const graphic of main.querySelectorAll<HTMLElement>('[data-scope="messages_table"] div[role="img"]')) {
		if (!isVisible(graphic) || graphic.closest('[role="toolbar"], [aria-hidden="true"]')) continue;
		if (graphic.closest('button, [role="button"], [contenteditable="true"], h1, h2, h3, h4, h5, h6, [role="heading"]'))
			continue;
		if (!inMessageScope(graphic)) continue;
		const boundary = messageBoundary(graphic);
		if (!boundary?.matches('[data-scope="messages_table"][data-message-id]')) continue;
		if (!/^(?:message|wiadomość)$/i.test(boundary.getAttribute("aria-roledescription") ?? "")) continue;
		if (findReplyButton(boundary)?.contains(graphic)) continue;
		// The graphic carries no message identity of its own. Only the
		// observed narrow shape qualifies: a nonempty label ending in the
		// standalone word "sticker" plus a CSS background image.
		const label = (graphic.getAttribute("aria-label") ?? "").trim();
		if (!/(?:^|\s)sticker\.?\s*$/i.test(label)) continue;
		if (!/background-image\s*:/i.test(graphic.getAttribute("style") ?? "")) continue;
		if (!stickers.some((existing) => existing === graphic || existing.contains(graphic))) stickers.push(graphic);
	}
	return stickers;
}

// A sent file renders as a download row with a visible label. Keep the shape
// narrow like the other collectors: toolbar, hidden, quoted, and decoration
// rows stay out, and the href shape never leaves the extension.
export function collectFileViewers(main: HTMLElement): HTMLElement[] {
	const files: HTMLElement[] = [];
	for (const link of main.querySelectorAll<HTMLAnchorElement>('[data-scope="messages_table"] a[download]')) {
		const element = link as HTMLElement;
		if (!isVisible(element) || element.closest('[role="toolbar"], [aria-hidden="true"]')) continue;
		if (!inMessageScope(element)) continue;
		const boundary = messageBoundary(element);
		if (!boundary?.matches('[data-scope="messages_table"][data-message-id]')) continue;
		if (findReplyButton(boundary)?.contains(element)) continue;
		if (!files.some((existing) => existing === element || existing.contains(element) || element.contains(existing)))
			files.push(element);
	}
	return files;
}
