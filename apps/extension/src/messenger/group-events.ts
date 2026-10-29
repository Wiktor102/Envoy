export function isGroupIntro(scope: Element): boolean {
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
