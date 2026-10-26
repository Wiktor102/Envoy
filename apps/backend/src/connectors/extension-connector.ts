import type { ConversationSnapshot, SendReplyCommand } from "@envoy/contracts";
import type { BrowserConnector } from "./browser-connector.js";

// The extension provides snapshots and retrieves claimed commands through the
// router. A command ID is handed out at most once, even if a poll is retried.
export class ExtensionConnector implements BrowserConnector {
	private conversation: ConversationSnapshot | null = null;
	private readonly claimed = new Set<string>();

	updateConversation(snapshot: ConversationSnapshot | null): void {
		this.conversation = snapshot;
	}

	readConversation(): ConversationSnapshot | null {
		return this.conversation;
	}

	claimSend(command: SendReplyCommand): SendReplyCommand | null {
		if (
			this.claimed.has(command.commandId) ||
			this.conversation?.chatId !== command.chatId ||
			this.conversation.revision !== command.expectedRevision
		) {
			return null;
		}
		this.claimed.add(command.commandId);
		return { ...command };
	}
}
