import type { AgentDecision, ConversationSnapshot, TaskState } from "@envoy/contracts";

export type EvaluationReason = "task_started" | "instructions_updated" | "new_message" | "user_resumed" | "message_edited";

// The task service is independent of both the model provider and the browser.
export interface Agent {
	run(
		task: TaskState,
		conversation: ConversationSnapshot,
		reason: EvaluationReason,
		signal?: AbortSignal,
	): Promise<AgentDecision>;
}
