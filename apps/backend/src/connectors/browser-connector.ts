import type { ConversationSnapshot, SendReplyCommand } from "@envoy/contracts";

// The task service does not depend on Chrome or on how a connector executes a
// claimed command. Another connector can implement the same contract.
export interface BrowserConnector {
	updateConversation(snapshot: ConversationSnapshot | null): void;
	readConversation(): ConversationSnapshot | null;
	claimSend(command: SendReplyCommand): SendReplyCommand | null;
}
