import type { TaskState } from "@envoy/contracts";

// TODO: Implement lifecycle, invalidation, cancellation, and duplicate prevention.
// Conversation text is input, never permission to change the user's instructions.
export interface TaskService {
	create(goal: string, chatId: string): Promise<TaskState>;
}
