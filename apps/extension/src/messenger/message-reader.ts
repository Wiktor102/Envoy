import type { ConversationSnapshot } from "@envoy/contracts";
import { isGroupSystemEvent } from "./group-events";
import {
	fileAttachment,
	getQuotedAttachments,
	gifAttachment,
	imageAttachment,
	isGifViewer,
	stickerAttachment,
	videoAttachment,
} from "./attachments";
import { findReplyButton, isVisible, normalizedText } from "./dom-queries";
import { readInlineText } from "./inline-text";
import { readDirection, readLabeledMessage, unavailableQuote, unsentPlaceholder } from "./message-labels";
import type { RenderedMessage } from "./rendered-message";

// These IDs describe rendered DOM nodes, not permanent Messenger message IDs.
const messageIds = new WeakMap<Element, string>();

function messageId(element: Element): string {
	let id = messageIds.get(element);
	if (!id) {
		id = crypto.randomUUID();
		messageIds.set(element, id);
	}
	return id;
}

function readStableId(boundary: Element | null): string | null {
	const value = boundary?.getAttribute("data-message-id")?.trim();
	return value ? value : null;
}

// Live evidence (single text message, EN + PL): the edited marker is a
// separate button inside the message's h4 heading, outside the body text.
// The heading structure of an edited reply was not captured, so no strip
// rule is guessed here.
function headingButtons(boundary: Element): HTMLElement[] {
	return [
		...boundary.querySelectorAll<HTMLElement>(
			'h4 button, h4 [role="button"], [role="heading"] button, [role="heading"] [role="button"]',
		),
	].filter((button) => !button.closest('[role="toolbar"]') && isVisible(button));
}

function isEditedLabel(value: string | null): boolean {
	const label = value?.trim().toLowerCase();
	return label === "edited" || label === "edytowano";
}

function hasEditedMarker(buttons: HTMLElement[]): boolean {
	return buttons.some((button) => isEditedLabel(button.getAttribute("aria-label")));
}

// Plain text messages only. Captions and attachment edits were not tested,
// so anything with attachments stays unknown rather than inferred.
function readEdited(
	boundary: Element | null,
	unique: boolean | Element | null,
	attachments: number,
	unsent: boolean,
	standaloneLike: boolean | undefined,
): boolean | null {
	if (!boundary || !unique || unsent || standaloneLike || attachments > 0 || isGroupSystemEvent(boundary)) return null;
	// One DOM query: the edited marker and the heading-button fallback read
	// the same buttons.
	const buttons = headingButtons(boundary);
	if (hasEditedMarker(buttons)) return true;
	if (buttons.length > 0) return null;
	return false;
}

function readReply(boundary: Element): ConversationSnapshot["messages"][number]["replyTo"] {
	const button = findReplyButton(boundary);
	if (!button) return null;
	const quote = button.querySelector<HTMLElement>('[dir="auto"]');
	const text = quote ? readInlineText(quote) : "";
	const context = boundary.querySelector<HTMLElement>('h4, [role="heading"]');
	const quoteText = normalizedText(quote?.textContent);
	// An edited reply may put the marker in the same h4 that supplies the
	// context. Its heading structure is unknown, so a co-occurring heading
	// button makes the context uncertain instead of guessed.
	const uncertainContext = headingButtons(boundary).length > 0;
	return {
		text:
			!quote || unsentPlaceholder.test(quoteText) || unavailableQuote.test(quoteText)
				? null
				: text.trim()
					? text
					: null,
		context: uncertainContext ? null : context?.textContent?.trim() || null,
		attachments: getQuotedAttachments(button).map(({ attachment }) => attachment),
	};
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

// A 1-1 header name is an unverified display string, never an identity proof.
// An unaccepted message request matches this shape exactly, so the name stays
// attribution-only metadata: shown as-is, sent to the model as context, and
// never part of the revision or pre-send validation.
function readParticipantName(main: HTMLElement): string | null {
	// The header lives outside the message table, inside the conversation
	// region that contains it. Never read names from message-table content:
	// the profile card at the start of scrollable history is unstable.
	const regions = [...main.querySelectorAll<HTMLElement>('[role="region"]')].filter(
		(region) => isVisible(region) && region.querySelector('[data-scope="messages_table"]'),
	);
	if (regions.length !== 1) return null;
	const region = regions[0]!;
	const candidates = [...region.querySelectorAll<HTMLElement>('a[role="link"] h3')].filter(
		(candidate) => !candidate.closest('[data-scope="messages_table"]') && isVisible(candidate),
	);
	if (candidates.length !== 1) return null;
	const name = normalizedText(candidates[0]!.textContent);
	if (!name || name.length > 200) return null;
	// Corroborate against the region-label heading, a sibling of the region
	// referenced via aria-labelledby. The heading level differs by site (h3 on
	// Facebook, h2 on Messenger), so match the text pattern, never the level.
	// Generated IDs are resolved, never matched by value.
	const labelledby = region.getAttribute("aria-labelledby")?.trim().split(/\s+/) ?? [];
	for (const id of labelledby) {
		if (!id) continue;
		const heading = document.getElementById(id);
		if (
			!heading ||
			!main.contains(heading) ||
			heading.parentElement !== region.parentElement ||
			!heading.matches("h1, h2, h3, h4, h5, h6, [role='heading']") ||
			!isVisible(heading as HTMLElement)
		)
			continue;
		// The labelled name must equal the header name exactly. Nicknames and
		// renames show whatever Messenger shows; a mismatch stays empty.
		const labelled = normalizedText(heading.textContent).match(/^(?:Conversation with|Konwersacja z:)\s+(.+)$/);
		if (labelled?.[1] === name) return name;
	}
	return null;
}

// A missing or unreadable header must never break message reading.
export function readParticipantHeader(main: HTMLElement): readonly string[] {
	try {
		const name = readParticipantName(main);
		return name ? [name] : [];
	} catch {
		return [];
	}
}

export function readMessages(rendered: RenderedMessage[]): ConversationSnapshot["messages"] {
	const boundaries = rendered.map((message) => message.boundary);
	const texts = rendered.map(({ element, images, videos, stickers, files, unsent, standaloneLike }) =>
		unsent ||
		images.some((image) => image === element) ||
		videos.some((video) => video === element) ||
		stickers.some((sticker) => sticker === element) ||
		files.some((file) => file === element)
			? ""
			: standaloneLike
				? "👍"
				: readInlineText(element),
	);
	return rendered.map(({ element, boundary, images, videos, stickers, files, unsent, standaloneLike }, index) => {
		// A shared boundary cannot safely assign metadata to one message.
		const unique = boundary && boundaries.indexOf(boundary) === boundaries.lastIndexOf(boundary);
		// A fresh bubble can share its container with a rendered delivery status.
		// Attribute only the one text candidate named by the per-message label;
		// leave status candidates and ambiguous matches unknown.
		const labeled = !unique && boundary ? readLabeledMessage(boundary) : null;
		const matchesLabel =
			labeled?.text &&
			texts[index]!.trim() === labeled.text &&
			rendered.filter((message, i) => message.boundary === boundary && texts[i]!.trim() === labeled.text).length === 1;
		const attachments = [
			...images.map((image) =>
				isGifViewer(image) ? gifAttachment(image) : imageAttachment(image.querySelector<HTMLImageElement>("img")),
			),
			...videos.map((viewer) => videoAttachment(viewer)),
			...stickers.map((sticker) => stickerAttachment(sticker)),
			...files.map(() => fileAttachment()),
		];
		return {
			id: messageId(element),
			stableId: readStableId(boundary),
			edited: readEdited(boundary, unique, attachments.length, unsent, standaloneLike),
			text: texts[index]!,
			direction: boundary && (unique || matchesLabel) ? readDirection(boundary) : "unknown",
			// The raw boundary label, kept only where direction is attributed.
			// Same gate, no You/Ty normalization: direction already carries
			// that, and the label is viewer-relative. Null where the gate fails
			// or the label is missing or malformed.
			sender: boundary && (unique || matchesLabel) ? (readLabeledMessage(boundary)?.sender ?? null) : null,
			replyTo: unique ? readReply(boundary) : null,
			attachments,
			reactions: unique ? readReactions(boundary) : [],
			unsent,
		};
	});
}
