import type { ConversationSnapshot } from "@envoy/contracts";
import { ConversationUnavailableError, messengerChatAdapter } from "../messenger/chat-adapter";

export function conversationErrorStatus(error: unknown): string {
	if (error instanceof ConversationUnavailableError) {
		switch (error.reason) {
			case "navigated":
				return "The selected chat changed. Reload this tab to use Envoy in it.";
			case "unsupported":
				return "Some messages can't be read. Envoy is paused for this conversation.";
			case "not-latest":
				return "Can't confirm the latest messages. Scroll to the bottom or reload this tab.";
			case "no-chat":
				return "Open a conversation and reload this tab to use Envoy in it.";
		}
	}
	return "Conversation messages are unavailable or still loading.";
}

// Observe Messenger, not the shadow-root output, so rendering never triggers another read.
export function watchConversation(onUpdate: (snapshot: ConversationSnapshot | null, status: string) => void): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let sequence = 0;
	let path = location.pathname;
	let readyAt = 0;
	let lastMessages: string | null = null;
	let previousMessages: string | null = null;

	function schedule() {
		if (location.pathname !== path) {
			path = location.pathname;
			readyAt = Date.now() + 300;
			previousMessages = lastMessages;
			lastMessages = null;
			sequence++;
			onUpdate(null, "Loading the selected conversation...");
		}
		if (timer !== undefined) return;
		timer = setTimeout(read, Math.max(100, readyAt - Date.now()));
	}

	async function read() {
		timer = undefined;
		if (stopped) return;
		const current = ++sequence;
		try {
			const snapshot = await messengerChatAdapter.readConversation();
			if (!stopped && current === sequence && location.pathname === path) {
				// Node IDs change when Messenger remounts old content. Comparing them
				// would make the old chat appear new during a route transition.
				// Sender labels are stripped the same way: a loading rename is
				// not a new conversation.
				const messages = JSON.stringify(
					snapshot.messages.map(({ id: _id, sender: _sender, ...message }) => message),
				);
				if (previousMessages && previousMessages !== "[]" && previousMessages === messages) {
					onUpdate(null, "Loading the selected conversation...");
					return;
				}
				previousMessages = null;
				lastMessages = messages;
				onUpdate(snapshot, `${snapshot.messages.length} loaded messages.`);
			}
		} catch (error) {
			if (stopped || current !== sequence) return;
			onUpdate(null, conversationErrorStatus(error));
		}
	}

	const observer = new MutationObserver(() => {
		sequence++;
		schedule();
	});
	observer.observe(document.body, {
		childList: true,
		characterData: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["aria-label", "alt", "dir", "data-scope", "role", "href", "src", "srcset", "sizes"],
	});
	window.addEventListener("popstate", schedule);
	// pushState does not emit popstate and may run without a DOM change.
	const interval = setInterval(schedule, 1000);
	schedule();
	return () => {
		stopped = true;
		sequence++;
		observer.disconnect();
		window.removeEventListener("popstate", schedule);
		clearInterval(interval);
		if (timer !== undefined) clearTimeout(timer);
	};
}
