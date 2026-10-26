import type { ConversationSnapshot, SendReplyCommand } from "@envoy/contracts";
import type { BrowserConnector } from "./browser-connector.js";

// Not connected to the API router. No browser commands are issued.
export class ExtensionConnector implements BrowserConnector {
	async readConversation(): Promise<ConversationSnapshot> {
		throw new Error("TODO: extension connector");
	}

	async sendReply(_command: SendReplyCommand): Promise<void> {
		throw new Error("TODO: validated extension send");
	}
}
