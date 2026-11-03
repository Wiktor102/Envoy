import OpenAI from "openai";
import type { AgentDecision, ConversationSnapshot, TaskState } from "@envoy/contracts";
import type { Agent, EvaluationReason } from "./agent.js";
import { collectMedia, dropVideoIndexes, formatAgentChat, userMessage } from "./conversation-payload.js";
import { parseDecision } from "./decision.js";
import { debugMedia, describeDecisionFailure, describeRequestFailure } from "./diagnostics.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";

const MODEL_API_BASE_URL = "https://api.meta.ai/v1";
const DEFAULT_MODEL = "muse-spark-1.3";
// Reasoning tokens count toward this cap, so it must leave room for the
// JSON decision after reasoning. Override with MODEL_MAX_COMPLETION_TOKENS.
const DEFAULT_MAX_COMPLETION_TOKENS = 16_000;

function maxCompletionTokens(): number {
	const raw = process.env.MODEL_MAX_COMPLETION_TOKENS?.trim();
	if (!raw) return DEFAULT_MAX_COMPLETION_TOKENS;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) return DEFAULT_MAX_COMPLETION_TOKENS;
	return value;
}

export class MetaModelAdapter implements Agent {
	async run(
		task: TaskState,
		conversation: ConversationSnapshot,
		reason: EvaluationReason,
		signal?: AbortSignal,
	): Promise<AgentDecision> {
		const apiKey = process.env.MODEL_API_KEY?.trim();
		if (!apiKey) throw new Error("MODEL_API_KEY is not configured");

		const client = new OpenAI({
			apiKey,
			baseURL: MODEL_API_BASE_URL,
			timeout: 60_000,
			maxRetries: 0,
			// Ignore SDK debug environment settings: requests contain private chat text.
			logLevel: "off",
		});
		const { payload: initialPayload, images, videos } = await collectMedia(conversation, signal);
		let payload = initialPayload;
		let pendingVideos = videos;
		const complete = () =>
			client.chat.completions.create(
				{
					model: process.env.MODEL_API_MODEL?.trim() || DEFAULT_MODEL,
					response_format: { type: "json_object" },
					max_completion_tokens: maxCompletionTokens(),
					messages: [
						{ role: "system", content: SYSTEM_PROMPT },
						{
							role: "developer",
							content:
								`User's instructions: ${JSON.stringify(task.goal)}\nEvaluation reason: ${reason}` +
								formatAgentChat(task.agentChat),
						},
						userMessage(payload, images, pendingVideos),
					],
				},
				{ signal },
			);
		let completion: Awaited<ReturnType<typeof complete>>;
		const blockBytes = (dataUrl: string) => {
			const comma = dataUrl.indexOf(",");
			return comma < 0 ? 0 : Buffer.byteLength(dataUrl.slice(comma + 1), "base64");
		};
		const describeBlocks = (urls: string[]) => urls.map((url) => `${blockBytes(url)}B`).join(", ");
		debugMedia(
			`request ${images.length} image blocks [${describeBlocks(images)}], ${pendingVideos.length} video blocks [${describeBlocks(pendingVideos)}]`,
		);
		let retriedConnection = false;
		for (;;) {
			try {
				completion = await complete();
				break;
			} catch (error) {
				debugMedia(describeRequestFailure(error));
				const status = (error as { status?: number })?.status;
				// A transport failure never completed, so one retry cannot
				// double-apply anything. Aborts stay aborted.
				if (status === undefined && !retriedConnection && !signal?.aborted) {
					retriedConnection = true;
					debugMedia("connection failed, retrying once");
					continue;
				}
				// The chat endpoint may not accept video blocks. Fall back to
				// evaluating with the clips presence-only instead of failing the
				// whole decision.
				if (!pendingVideos.length || status !== 400) throw error;
				debugMedia("video blocks rejected, retrying presence-only");
				payload = dropVideoIndexes(payload);
				pendingVideos = [];
			}
		}

		let parsed: unknown;
		const decisionText = completion.choices[0]?.message?.content ?? "";
		try {
			parsed = JSON.parse(decisionText);
		} catch {
			debugMedia(`model decision unparsable: ${describeDecisionFailure(completion)}`);
			throw new Error("Invalid model decision");
		}
		try {
			return parseDecision(parsed);
		} catch (error) {
			debugMedia(`model decision invalid: ${describeDecisionFailure(completion)}`);
			throw error;
		}
	}
}
