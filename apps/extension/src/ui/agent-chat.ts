import type { AgentChatMessage } from "@envoy/contracts";
import type { ExtensionStrings } from "../i18n";
import { ENVOY_LOGO_DATA_URI } from "./logo";
import { makeSender, makeText } from "./view-format";

export function createAgentChat(list: HTMLOListElement) {
	let renderedKey: string | null = null;
	const openToolCalls = new Set<string>();

	return {
		// The next render rebuilds the list, for example after a language change.
		invalidate() {
			renderedKey = null;
		},
		// A different task starts with its tool calls collapsed.
		reset() {
			renderedKey = null;
			openToolCalls.clear();
		},
		render(chat: readonly AgentChatMessage[], strings: ExtensionStrings) {
			const key = JSON.stringify(chat.map(({ id, role, text, body }) => [id, role, text, body]));
			if (key === renderedKey) return;
			renderedKey = key;
			list.replaceChildren();
			for (const message of chat) {
				const item = document.createElement("li");
				item.dataset.role = message.role;
				if (message.role === "event" && message.body) {
					item.classList.add("tool-call");
					const details = document.createElement("details");
					details.open = openToolCalls.has(message.id);
					details.addEventListener("toggle", () => {
						if (details.open) openToolCalls.add(message.id);
						else openToolCalls.delete(message.id);
					});
					const summary = document.createElement("summary");
					summary.textContent = message.text;
					const body = document.createElement("p");
					body.className = "message-text";
					body.dir = "auto";
					body.textContent = message.body;
					details.append(summary, body);
					item.append(details);
				} else {
					if (message.role !== "event") {
						const sender = makeSender(message.role === "agent" ? strings.agentName : strings.you);
						if (message.role === "agent") {
							sender.classList.add("agent-sender");
							const avatar = document.createElement("img");
							avatar.className = "agent-avatar";
							avatar.src = ENVOY_LOGO_DATA_URI;
							avatar.alt = "";
							avatar.setAttribute("aria-hidden", "true");
							avatar.width = 14;
							avatar.height = 14;
							sender.prepend(avatar);
						}
						item.append(sender);
					}
					const text = makeText();
					text.textContent = message.text;
					item.append(text);
				}
				list.append(item);
			}
		},
	};
}
