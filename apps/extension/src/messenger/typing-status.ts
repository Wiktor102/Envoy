import { hasPresentationRole, MESSAGE_METADATA_SELECTOR } from "./dom-queries";

// A live typing announcement is status UI, not a message. It arrives in a
// messages_table scope without message metadata and must never hide real
// messages, attachments, or ambiguous content. Match structure (a live region
// with only announcement text, plus the observed aria-hidden typing visual),
// never height alone or translated words.
function isLiveAnnouncement(element: Element): boolean {
	const value = element.getAttribute("aria-live")?.trim().toLowerCase();
	return value === "polite" || value === "assertive";
}

export function isTypingStatus(scope: Element): boolean {
	if (!scope.matches('[data-scope="messages_table"]')) return false;
	if (scope.matches(MESSAGE_METADATA_SELECTOR) || scope.querySelector(MESSAGE_METADATA_SELECTOR)) return false;
	if (!isLiveAnnouncement(scope) && ![...scope.querySelectorAll("[aria-live]")].some(isLiveAnnouncement)) return false;
	if (scope.matches("[aria-label], [alt]")) return false;
	if (scope.matches("[dir]") && !isLiveAnnouncement(scope)) return false;

	// Static SVG shapes in the observed typing avatar. Text-capable and embedded
	// elements (text, title, a, foreignObject, nested svg) stay out.
	const avatarShapes = new Set(["mask", "g", "circle", "image"]);
	function avatarSvg(svg: Element): boolean {
		if (!svg.matches("svg") || svg.getAttribute("role") !== "img") return false;
		if (!svg.getAttribute("aria-label")?.trim()) return false;
		if (svg.matches("[alt], [dir]")) return false;
		function shapes(node: Node): boolean {
			if (node.nodeType === 3) return !node.nodeValue?.trim();
			if (node.nodeType !== 1) return true;
			const child = node as Element;
			if (!avatarShapes.has(child.tagName.toLowerCase())) return false;
			if (child.matches("[aria-label], [alt], [dir]")) return false;
			return [...child.childNodes].every(shapes);
		}
		return [...svg.childNodes].every(shapes);
	}

	// Avatars seen per aria-hidden visual root. Hidden content is only ignored
	// inside a root that validates as the observed typing visual.
	const avatars: number[] = [];
	function avatarList(list: Element): boolean {
		const items = [...list.childNodes].filter((node) => node.nodeType === 1);
		if (items.length === 0) return false;
		let seenItem = false;
		for (const item of items) {
			const element = item as Element;
			if (element.getAttribute("role") !== "listitem") {
				// Empty spacer between items. Anything with content stays unrecognized.
				if (!element.matches("div, span")) return false;
				if (!hasPresentationRole(element)) return false;
				if (element.matches("[alt], [dir], [aria-label]")) return false;
				if (
					![...element.childNodes].every(
						(node) => node.nodeType !== 1 && (node.nodeType !== 3 || !node.nodeValue?.trim()),
					)
				)
					return false;
				continue;
			}
			if (!element.matches("div, span")) return false;
			if (element.matches("[alt], [dir], [aria-label]")) return false;
			// The avatar svg may sit inside plain wrapper divs. Anything beside
			// the single nested svg stays unrecognized.
			let current: Element = element;
			for (;;) {
				if (![...current.childNodes].every((node) => node.nodeType === 1 || !node.nodeValue?.trim())) return false;
				const inner = [...current.childNodes].filter((node) => node.nodeType === 1);
				if (inner.length !== 1) return false;
				const only = inner[0] as Element;
				if (only.matches("svg")) {
					if (!avatarSvg(only)) return false;
					break;
				}
				if (!only.matches("div, span")) return false;
				if (!hasPresentationRole(only)) return false;
				if (only.matches("[alt], [dir], [aria-label]")) return false;
				current = only;
			}
			avatars[avatars.length - 1]! += 1;
			seenItem = true;
		}
		if (!seenItem) return false;
		return [...list.childNodes].every((node) => node.nodeType === 1 || !node.nodeValue?.trim());
	}

	function status(node: Node, visual: boolean, live: boolean): boolean {
		if (node.nodeType === 3) return live || !node.nodeValue?.trim();
		if (node.nodeType !== 1) return true;
		const element = node as Element;
		if (!element.matches("div, span")) return false;
		if (element.matches("[alt]")) return false;
		const nowLive = live || (!visual && isLiveAnnouncement(element));
		if (element.matches("[dir]") && !nowLive) return false;
		if (element.matches("[aria-label]")) return false;
		const entersVisual = !live && !visual && element.getAttribute("aria-hidden") === "true";
		const nowVisual = visual || entersVisual;
		if (entersVisual) avatars.push(0);
		const role = element.getAttribute("role");
		let ok: boolean;
		if (!nowVisual) {
			ok =
				[null, "presentation", "none", "status", "log"].includes(role) &&
				[...element.childNodes].every((child) => status(child, false, nowLive));
		} else if (role === "list") {
			ok = avatarList(element);
		} else if (hasPresentationRole(element)) {
			ok = [...element.childNodes].every((child) => status(child, true, false));
		} else {
			ok = false;
		}
		if (entersVisual) {
			const seen = avatars.pop()!;
			const empty = element.querySelectorAll("*").length === 0 && !element.textContent?.trim();
			ok = ok && (seen > 0 || empty);
		}
		return ok;
	}
	return [...scope.childNodes].every((child) => status(child, false, isLiveAnnouncement(scope)));
}
