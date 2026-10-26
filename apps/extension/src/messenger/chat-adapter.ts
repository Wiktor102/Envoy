import type { ConversationSnapshot, SendReplyCommand } from "@envoy/contracts";

export interface MessengerChatAdapter {
	readConversation(): Promise<ConversationSnapshot>;
	sendReply(command: SendReplyCommand): Promise<void>;
}

// TODO: Messenger DOM access. Deliberately contains no selectors or send logic.
export const messengerChatAdapter: MessengerChatAdapter = {
	async readConversation() {
		throw new Error("TODO: Messenger chat reader");
	},
	async sendReply(_command) {
		throw new Error("TODO: validated Messenger send");
	},
};
