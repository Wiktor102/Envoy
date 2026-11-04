import { ConversationUnavailableError } from "./conversation-error";

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

export function readInlineText(element: Element): string {
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
		if (child.matches("blockquote")) {
			// Messenger renders a line starting with "> " as a blockquote and
			// omits the markers from the visible text, while the per-message
			// accessibility label keeps the original text. Restore the
			// markers so the text matches the sent message; a nested quote
			// gains one marker level per ancestor from the recursion.
			blockBreakPending = true;
			const quoted = readInlineText(child);
			appendText(
				quoted
					.split("\n")
					.map((line) => (line ? `> ${line}` : ">"))
					.join("\n"),
			);
			blockBreakPending = true;
			return;
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
