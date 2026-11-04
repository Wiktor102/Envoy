import type { AgentDecision, ConversationMessage, ConversationSnapshot, TaskState } from "@envoy/contracts";
import type { Agent, EvaluationReason } from "../../src/agent/agent.js";
import { TaskService } from "../../src/tasks/service.js";

export function snapshot(
	revision = "r1",
	text = "Can we meet?",
	direction: ConversationMessage["direction"] = "incoming",
	stableId: string | null = null,
	edited: boolean | null = false,
): ConversationSnapshot {
	return {
		chatId: "chat-1",
		revision,
		messages: [
			{
				id: "node-1",
				stableId,
				edited,
				text,
				direction,
				replyTo: null,
				attachments: [],
				reactions: [],
				unsent: false,
			},
		],
		participants: [],
	};
}

export class ControlledAgent implements Agent {
	calls: {
		task: TaskState;
		snapshot: ConversationSnapshot;
		reason: EvaluationReason;
		signal: AbortSignal | undefined;
		resolve: (decision: AgentDecision) => void;
		reject: (error: unknown) => void;
	}[] = [];
	run(
		task: TaskState,
		conversation: ConversationSnapshot,
		reason: EvaluationReason,
		signal?: AbortSignal,
	): Promise<AgentDecision> {
		return new Promise((resolve, reject) =>
			this.calls.push({ task, snapshot: conversation, reason, signal, resolve, reject }),
		);
	}
}

export function setup() {
	let time = 1_000;
	const agent = new ControlledAgent();
	const service = new TaskService(agent, { now: () => time, leaseMs: 100_000 });
	return {
		agent,
		service,
		advance: (amount: number) => {
			time += amount;
		},
	};
}

export async function resolveReply(agent: ControlledAgent, index = 0, text = "Tuesday works.") {
	agent.calls[index]!.resolve({ action: "reply", text });
	await Promise.resolve();
}
