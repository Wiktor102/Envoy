import { hasControlCharacters, MAX_TASK_TEXT_LENGTH } from "@envoy/contracts";
import type { ConversationSnapshot, SendReplyCommand, SendResult } from "@envoy/contracts";
import { readCapturedConversation } from "./conversation-capture";
import { performSend } from "./send-reply";

export { ConversationUnavailableError } from "./conversation-error";
export { bindMessengerDocument } from "./document-binding";

export interface MessengerChatAdapter {
	readConversation(): Promise<ConversationSnapshot>;
	sendReply(command: SendReplyCommand, authorize: () => Promise<boolean>, isCurrent?: () => boolean): Promise<SendResult>;
}

const attempts = new Map<string, { signature: string; result: Promise<SendResult> }>();
let sendInProgress = false;

export const messengerChatAdapter: MessengerChatAdapter = {
	async readConversation() {
		return (await readCapturedConversation()).snapshot;
	},
	sendReply(command, authorize, isCurrent = () => true) {
		if (
			!command.commandId ||
			!command.chatId ||
			!command.expectedRevision ||
			!command.text.trim() ||
			command.text.length > MAX_TASK_TEXT_LENGTH ||
			hasControlCharacters(command.text)
		)
			return Promise.resolve("rejected");
		const signature = JSON.stringify([command.chatId, command.expectedRevision, command.text]);
		const previous = attempts.get(command.commandId);
		if (previous) return previous.signature === signature ? previous.result : Promise.resolve("rejected");
		if (sendInProgress) return Promise.resolve("rejected");
		sendInProgress = true;
		const result = performSend(command, authorize, isCurrent).finally(() => {
			sendInProgress = false;
		});
		attempts.set(command.commandId, { signature, result });
		return result;
	},
};
