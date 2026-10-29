import type { AgentDecision, ConversationSnapshot, TaskState } from "@envoy/contracts";

// The task service is independent of both the model provider and the browser.
export interface Agent {
	run(task: TaskState, conversation: ConversationSnapshot, signal?: AbortSignal): Promise<AgentDecision>;
}
