// Attributes that only real messages carry.
export const MESSAGE_METADATA_SELECTOR =
	"[data-message-id], [aria-roledescription], [data-message-direction], [data-message-type], [data-attachment-type]";

// A plain wrapper: no role of its own beyond presentation.
export function hasPresentationRole(element: Element): boolean {
	return [null, "presentation", "none"].includes(element.getAttribute("role"));
}

export function normalizedText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

export function isVisible(element: HTMLElement): boolean {
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

// A message scope can be nested inside a row or article. Use the nearest boundary
// so metadata is never borrowed from an adjacent message.
export function messageBoundary(element: HTMLElement): Element | null {
	return element.closest('[data-scope="messages_table"], [role="row"], [role="article"]');
}

export function findReplyButton(boundary: Element): HTMLElement | undefined {
	return [...boundary.querySelectorAll<HTMLElement>('button[aria-label], [role="button"][aria-label]')].find((element) => {
		const label = element.getAttribute("aria-label") ?? "";
		return (
			!element.closest('[role="toolbar"]') &&
			(/na któr[aą] odpowiadasz/i.test(label) || /(?:go to|jump to|view).*(?:repl|original message)/i.test(label))
		);
	});
}

export function isMessengerPhotoLink(anchor: HTMLAnchorElement): boolean {
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
