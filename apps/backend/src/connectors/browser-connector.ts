import type { ConversationSnapshot, SendReplyCommand } from "@envoy/contracts";

// Keep browser access replaceable by a hosted connector later.
export interface BrowserConnector {
	readConversation(): Promise<ConversationSnapshot>;
	// TODO: Validate chat/revision, reject stale commands, and deduplicate sends.
	sendReply(command: SendReplyCommand): Promise<void>;
}
