import type { ControllerState } from "../controller";
import { format, type ExtensionStrings } from "../i18n";
import { makeSender, makeText, messagePreview, senderLabel } from "./view-format";
import type { ViewElements } from "./view-elements";

export function createConversationPreview({
	chatId,
	chatName,
	conversationStatus,
	conversationNotice,
	conversation,
	conversationEmpty,
}: ViewElements) {
	let renderedKey: string | null = null;

	return {
		// The next render rebuilds the list, for example after a language change.
		invalidate() {
			renderedKey = null;
		},
		render(state: ControllerState, strings: ExtensionStrings) {
			const snapshot = state.snapshot;
			chatId.textContent = snapshot ? format(strings.chatLine, { id: snapshot.chatId }) : strings.noConversation;
			// Unverified header display string. Hidden when the header is missing
			// or ambiguous; never a verified-person claim.
			const name = snapshot?.participants[0] ?? null;
			chatName.textContent = name ? format(strings.chatNameLine, { name }) : "";
			chatName.hidden = !name;
			conversationStatus.textContent = state.conversationStatus;
			conversationNotice.textContent = snapshot ? "" : state.conversationStatus;
			conversationNotice.hidden = Boolean(snapshot);
			conversationEmpty.hidden = Boolean(snapshot?.messages.length);
			const key = snapshot ? JSON.stringify([snapshot.chatId, snapshot.revision, snapshot.participants]) : null;
			if (key === renderedKey) return;
			renderedKey = key;
			conversation.replaceChildren();
			if (!snapshot) return;

			// In a 1-1 chat the incoming side is the single named participant.
			// Groups and ambiguous headers leave participants empty, keeping the
			// generic label. A known per-message label names that bubble's sender
			// instead; it is display data, never a verified identity.
			const incomingLabel = snapshot.participants[0] ?? strings.incomingLabel;
			for (const message of snapshot.messages.slice(-5)) {
				const item = document.createElement("li");
				item.dataset.direction = message.direction;
				const sender = makeSender(senderLabel(message.direction, message.sender, incomingLabel, strings));
				const text = makeText();
				text.textContent = messagePreview(message, strings);
				item.append(sender, text);
				conversation.append(item);
			}
		},
	};
}
