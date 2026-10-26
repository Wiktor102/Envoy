import type { TaskState } from '@envoy/contracts';

// TODO: Choose storage and retention. The backend owns all task/pending state.
export interface TaskRepository {
  get(taskId: string): Promise<TaskState | null>;
  save(task: TaskState): Promise<void>;
}
