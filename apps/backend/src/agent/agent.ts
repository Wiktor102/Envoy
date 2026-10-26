import type { ConversationSnapshot, TaskState } from '@envoy/contracts';

// TODO: Add the reasoning loop and explicit wait/reply/ask/finish decisions.
export interface Agent {
  run(task: TaskState, conversation: ConversationSnapshot): Promise<void>;
}
