const playPath =
	"M13.126 9.949c1.5-.866 1.5-3.031 0-3.897l-6.75-3.898C4.875 1.288 3 2.371 3 4.103v7.794c0 1.732 1.875 2.815 3.375 1.949l6.75-3.897z";

// The observed Messenger animated preview is a blob image with a nested play
// control. Require the exact play glyph and message boundary, not a label.
export function isAnimatedPreview(button: HTMLElement): boolean {
	if (!button.matches('[role="button"][tabindex="0"]') || button.closest('[aria-hidden="true"], [role="toolbar"]'))
		return false;
	const scope = button.closest('[data-scope="messages_table"]');
	if (!scope?.matches("[data-message-id][aria-roledescription]")) return false;
	if (
		button.querySelector("video, audio, object, embed, iframe, a[download], [data-message-type], [data-attachment-type]")
	)
		return false;
	const images = button.querySelectorAll<HTMLImageElement>("img");
	if (images.length !== 1 || images[0]!.getAttribute("alt") !== "" || !images[0]!.getAttribute("src")?.startsWith("blob:"))
		return false;
	const controls = button.querySelectorAll<HTMLElement>('[role="button"][tabindex="0"]');
	if (controls.length !== 1) return false;
	const control = controls[0]!;
	const svg = control.querySelector('svg[viewBox="0 0 16 16"][aria-hidden="true"]');
	return Boolean(
		svg &&
		svg.querySelectorAll("path").length === 1 &&
		svg.querySelector("path")?.getAttribute("d") === playPath &&
		!control.contains(images[0]!),
	);
}
