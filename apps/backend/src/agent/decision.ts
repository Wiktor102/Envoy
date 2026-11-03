import type { AgentDecision } from "@envoy/contracts";
import { hasControlCharacters, MAX_TASK_TEXT_LENGTH } from "@envoy/contracts";

function invalidDecision(): never {
	throw new Error("Invalid model decision");
}

export function parseDecision(value: unknown): AgentDecision {
	if (!value || typeof value !== "object" || !("action" in value)) invalidDecision();
	if (value.action === "wait") return { action: "wait" };
	if (value.action !== "reply" && value.action !== "ask" && value.action !== "finish") {
		invalidDecision();
	}
	if (!("text" in value) || typeof value.text !== "string") invalidDecision();
	if (value.action === "reply" && hasControlCharacters(value.text)) {
		invalidDecision();
	}
	const text = value.text.trim();
	if (!text || text.length > MAX_TASK_TEXT_LENGTH) invalidDecision();
	return { action: value.action, text };
}
