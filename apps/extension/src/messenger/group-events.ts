// A 1-1 thread introduction: a bare avatar img, an h3 name, and intro content
// such as the E2EE notice with its help button (a button, not a link). Mirrors
// the group-intro convention: structure only (tags, roles, attributes), never
// classes, image URLs, or notice wording. Real messages carry message metadata
// and use h4, not h3. A miss fails safe to unknown direction, never hides content.
function isDirectIntro(scope: Element): boolean {
	return (
		scope.matches('[data-scope="messages_table"][data-release-focus-from="CLICK"][tabindex]') &&
		!scope.matches("[data-message-id], [aria-roledescription], [data-message-type], [data-attachment-type]") &&
		!scope.querySelector(
			"[data-message-id], [aria-roledescription], [data-message-type], [data-attachment-type], video, audio, object, embed, iframe",
		) &&
		Boolean(scope.querySelector("h3")) &&
		Boolean(scope.querySelector("img")) &&
		Boolean(scope.querySelector('[role="button"]'))
	);
}

export function isThreadIntro(scope: Element): boolean {
	return isGroupIntro(scope) || isDirectIntro(scope);
}

function isGroupIntro(scope: Element): boolean {
	return (
		scope.matches('[data-scope="messages_table"][data-release-focus-from="CLICK"][tabindex]') &&
		!scope.matches("[data-message-id], [aria-roledescription]") &&
		!scope.querySelector("[data-message-id], [aria-roledescription], video, audio, object, embed, iframe") &&
		Boolean(scope.querySelector(":scope > h3, :scope > div h3")) &&
		Boolean(scope.querySelector('[role="img"] img')) &&
		Boolean(scope.querySelector('ul > li [role="button"]'))
	);
}

export function isGroupSystemEvent(scope: Element): boolean {
	if (
		!scope.matches('[data-scope="messages_table"][data-release-focus-from="CLICK"][tabindex]') ||
		scope.matches("[data-message-id], [aria-roledescription]") ||
		scope.querySelector(
			'[data-message-id], [aria-roledescription], h1, h2, h3, h4, h5, h6, [role="heading"], button, [role="button"], img, svg, video, audio, canvas, a, input, [contenteditable]',
		)
	)
		return false;
	const text = scope.querySelectorAll('[dir="auto"]');
	return (
		text.length === 1 &&
		Boolean(text[0]?.textContent?.trim()) &&
		Boolean(text[0]?.querySelector('[role="presentation"]')) &&
		Boolean(text[0]?.parentElement?.closest('[role="presentation"]'))
	);
}
