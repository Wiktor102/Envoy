import type { ConversationSnapshot, SendReplyCommand } from "@envoy/contracts";

// The task service does not depend on Chrome or on how a connector executes a
// claimed command. Another connector can implement the same contract.
export interface BrowserConnector {
	updateConversation(snapshot: ConversationSnapshot | null): void;
	readConversation(): ConversationSnapshot | null;
	claimSend(command: SendReplyCommand): SendReplyCommand | null;
}

// Null-safe identity check for one conversation view. Prefer this over an
// inline `view?.chatId !== chatId || view.revision !== revision` chain, which
// only works in that disjunct order and throws when reordered.
export function sameConversation(view: ConversationSnapshot | null, chatId: string, revision: string): boolean {
	return view?.chatId === chatId && view.revision === revision;
}
