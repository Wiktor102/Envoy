import { messageContent } from "@envoy/contracts";
import type { ConversationSnapshot } from "@envoy/contracts";
import { detectLocale, getStrings, loadedMessagesText } from "../i18n";
import { ConversationUnavailableError, messengerChatAdapter } from "../messenger/chat-adapter";

export function conversationErrorStatus(error: unknown): string {
	const strings = getStrings();
	if (error instanceof ConversationUnavailableError) {
		switch (error.reason) {
			case "navigated":
				return strings.chatChanged;
			case "unsupported":
				return strings.unreadablePaused;
			case "not-latest":
				return strings.confirmLatest;
			case "no-chat":
				return strings.openAndReload;
		}
	}
	return strings.messagesUnavailable;
}

function loadedStatus(count: number): string {
	return loadedMessagesText(detectLocale(), count);
}

function loadingStatus(): string {
	return getStrings().loadingConversation;
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
			onUpdate(null, loadingStatus());
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
				const messages = JSON.stringify(snapshot.messages.map(messageContent));
				// An empty previous snapshot carries no content to compare, so
				// only a non-empty match counts as still loading.
				const stillLoading = previousMessages !== null && previousMessages !== "[]" && previousMessages === messages;
				if (stillLoading) {
					onUpdate(null, loadingStatus());
					return;
				}
				previousMessages = null;
				lastMessages = messages;
				onUpdate(snapshot, loadedStatus(snapshot.messages.length));
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
