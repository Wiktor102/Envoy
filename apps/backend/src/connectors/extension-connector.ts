import type { ConversationSnapshot, SendReplyCommand } from "@envoy/contracts";
import { sameConversation, type BrowserConnector } from "./browser-connector.js";

// The extension provides snapshots and retrieves claimed commands through the
// router. A command ID is handed out at most once, even if a poll is retried.
export class ExtensionConnector implements BrowserConnector {
	// Command IDs accumulate for the life of this connector. The task service
	// replaces the connector on start and erase, so the set stays bounded.
	private conversation: ConversationSnapshot | null = null;
	private readonly claimed = new Set<string>();

	updateConversation(snapshot: ConversationSnapshot | null): void {
		this.conversation = snapshot;
	}

	readConversation(): ConversationSnapshot | null {
		return this.conversation;
	}

	// Claim issues a command at most once; authorize (in the task service)
	// confirms it again immediately before the tab sends. The two phases stay
	// separate so a stale poll result can never authorize a send.
	claimSend(command: SendReplyCommand): SendReplyCommand | null {
		if (
			this.claimed.has(command.commandId) ||
			!sameConversation(this.conversation, command.chatId, command.expectedRevision)
		) {
			return null;
		}
		this.claimed.add(command.commandId);
		return { ...command };
	}
}
