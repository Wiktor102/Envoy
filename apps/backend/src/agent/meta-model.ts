import type { ConversationSnapshot } from "@envoy/contracts";

// Backend only. Future API credentials stay here, never in shared/browser code.
export class MetaModelAdapter {
	async generateReply(_goal: string, _conversation: ConversationSnapshot): Promise<string> {
		throw new Error("TODO: Meta Model API adapter");
	}
}
