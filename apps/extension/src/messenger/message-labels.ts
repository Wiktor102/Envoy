import type { ConversationMessage } from "@envoy/contracts";
import { isGroupSystemEvent } from "./group-events";

// Messenger keeps an unsent message's bubble and replaces its text with a
// placeholder. The placeholder is not the sender's words. A real message that
// reads like one is treated the same way, which only stops the agent.
export const unsentPlaceholder =
	/^(?:[^\n]{1,100} )?(?:unsent a message|cofn\S*(?: ?\(-[^)]*\))? wysłanie wiadomości)\.?$|^(?:this |ta )?(?:message|wiadomość) (?:was |została )?(?:unsent|removed|deleted|cofnięta|usunięta)\.?$|^usunięto wiadomość\.?$/i;
// A quote of a withdrawn message names its state instead of quoting it.
export const unavailableQuote =
	/^(?:message unavailable|(?:the )?original message (?:was )?(?:unsent|removed|deleted)|wiadomość (?:jest )?niedostępna|oryginalna wiadomość została (?:cofnięta|usunięta))\.?$/i;

// Only metadata that explicitly describes the sender is used here. Message
// alignment, color, and an arbitrary person's name do not establish who sent it.
export function readLabeledMessage(boundary: Element): { sender: string; text: string } | null {
	// This is Messenger's per-message accessibility label, not message text or
	// a group heading. Consecutive bubbles often have no sender heading at all.
	if (!boundary.matches('[data-scope="messages_table"][data-message-id]')) return null;
	if (!/^(?:message|wiadomość)$/i.test(boundary.getAttribute("aria-roledescription") ?? "")) return null;
	const label = boundary.getAttribute("aria-label") ?? "";
	const match = label.match(/^(?:O|At) [^\n]*?\d{1,2}:\d{2}(?:\s?[AP]M)?, ([^:\n]{1,100})(?::(?:\s|$)|$)/i);
	if (!match) return null;
	const sender = match[1]?.trim();
	return sender ? { sender, text: label.slice(match[0].length).trim() } : null;
}

export function readLabeledSender(boundary: Element): string | null {
	return readLabeledMessage(boundary)?.sender ?? null;
}

export function readDirection(boundary: Element): ConversationMessage["direction"] {
	if (isGroupSystemEvent(boundary)) return "system";
	const directions = new Set<ConversationMessage["direction"]>();
	const explicit = boundary.getAttribute("data-message-direction");
	if (explicit === "incoming" || explicit === "outgoing") directions.add(explicit);
	const sender = readLabeledSender(boundary);
	if (sender) directions.add(/^(?:you|ty)$/i.test(sender) ? "outgoing" : "incoming");

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
