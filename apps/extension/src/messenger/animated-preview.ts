const playPath =
	"M13.126 9.949c1.5-.866 1.5-3.031 0-3.897l-6.75-3.898C4.875 1.288 3 2.371 3 4.103v7.794c0 1.732 1.875 2.815 3.375 1.949l6.75-3.897z";

// A message-table button with no embedded player, download, or typed attachment.
function isPlainMessageButton(button: HTMLElement, selector: string): boolean {
	if (!button.matches(selector) || button.closest('[aria-hidden="true"], [role="toolbar"]')) return false;
	const scope = button.closest('[data-scope="messages_table"]');
	if (!scope?.matches("[data-message-id][aria-roledescription]")) return false;
	return !button.querySelector(
		"video, audio, object, embed, iframe, a[download], [data-message-type], [data-attachment-type]",
	);
}

// Standalone "gif" word in Messenger-supplied labels and alt text.
export const GIF_WORD_SOURCE = "(?:^|\\s)gif(?=$|[\\s:.,])";

export function isGifLabel(value: string): boolean {
	return new RegExp(GIF_WORD_SOURCE, "i").test(value);
}

function singleImage(button: HTMLElement): HTMLImageElement | null {
	const images = button.querySelectorAll("img");
	return images.length === 1 ? images[0]! : null;
}

// Service chrome around a GIF render: a caption naming GIPHY or a label
// offering to open the GIF. Observed on quote previews and on multi-image
// GIF links whose render alt carries tags instead of the format word.
export function hasGifChrome(scope: Element): boolean {
	return [...scope.querySelectorAll<HTMLElement>("a, span, [aria-label]")].some(
		(element) =>
			element.textContent?.trim() === "GIPHY" ||
			/(?:^|\s)(?:open|otwórz)\s+gif(?:$|[\s:.,])/i.test(element.getAttribute("aria-label") ?? ""),
	);
}

// An encrypted-chat GIF is a button holding a lone image whose alt names the
// format. No play control or tabindex required; some variants omit them. The
// alt word carries the classification: photo buttons never carry it, and a
// gif never forwards bytes, so over-matching only pauses.
export function isGifButton(button: HTMLElement): boolean {
	if (!isPlainMessageButton(button, '[role="button"]')) return false;
	const image = singleImage(button);
	if (!image) return false;
	return isGifLabel(image.getAttribute("alt") ?? "");
}

// The observed Messenger animated preview is a blob image with a nested play
// control. Require the exact play glyph and message boundary, not a label.
export function isAnimatedPreview(button: HTMLElement): boolean {
	if (!isPlainMessageButton(button, '[role="button"][tabindex]')) return false;
	const image = singleImage(button);
	if (!image || image.getAttribute("alt") !== "" || !image.getAttribute("src")?.startsWith("blob:")) return false;
	const controls = button.querySelectorAll<HTMLElement>('[role="button"][tabindex]');
	if (controls.length !== 1) return false;
	const control = controls[0]!;
	const svg = control.querySelector('svg[viewBox="0 0 16 16"][aria-hidden="true"]');
	return Boolean(
		svg &&
		svg.querySelectorAll("path").length === 1 &&
		svg.querySelector("path")?.getAttribute("d") === playPath &&
		!control.contains(image),
	);
}
