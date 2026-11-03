// Credentials and API responses stay on the backend. Never log message content
// or provider errors, which may include request data.

// One-line diagnostics for live triage (which fetches succeeded, which
// blocks reach the model). Set ENVOY_DEBUG_MEDIA=1 on the backend; quiet
// otherwise. Never logs URLs or conversation text.
export function debugMedia(line: string): void {
	if (process.env.ENVOY_DEBUG_MEDIA) console.info(`[envoy] ${line}`);
}

// Status, class, and network cause chain only: bodies may include request
// data. Transports nest: undici's outer "fetch failed" carries the specific
// error in its own cause.
export function describeRequestFailure(error: unknown): string {
	const failure = error as { status?: number; cause?: unknown; constructor?: { name?: string } };
	const status = failure?.status ?? "unknown";
	const kind = failure?.constructor?.name ?? "unknown";
	const chain: string[] = [];
	let current: unknown = failure?.cause;
	while (current instanceof Error && chain.length < 3) {
		const code = (current as { code?: string }).code ?? "?";
		chain.push(`${code}: ${current.message.slice(0, 160)}`);
		current = (current as { cause?: unknown }).cause;
	}
	const causedBy = chain.length ? ` caused by ${chain.join("; caused by ")}` : "";
	return `request failed: status ${status} (${kind})${causedBy}`;
}

// Finish reasons worth naming in a log line. Anything else stays "unlisted":
// provider strings are arbitrary and never reach the log.
const KNOWN_FINISH_REASONS = new Set(["stop", "length", "tool_calls", "content_filter", "function_call"]);

// Structural view of a chat completion for failure diagnostics. Fields stay
// unknown because providers omit or reshape them; every access below guards.
interface DecisionFailureResponse {
	choices?:
		| readonly {
				finish_reason?: string;
				message?: {
					content?: unknown;
					refusal?: unknown;
					tool_calls?: readonly unknown[];
				} | null;
		  }[]
		| null;
	usage?: {
		prompt_tokens?: unknown;
		completion_tokens?: unknown;
		total_tokens?: unknown;
		completion_tokens_details?: { reasoning_tokens?: unknown } | null;
	} | null;
}

function describeFinishReason(reason: unknown): string {
	if (reason === undefined) return "missing";
	if (typeof reason === "string" && KNOWN_FINISH_REASONS.has(reason)) return reason;
	return "unlisted";
}

// One content-free metadata line for a decision that cannot be parsed or
// validated: choice count, allowlisted finish reason, content presence, refusal
// presence, tool-call count, and numeric token usage. Content distinguishes
// missing, null, empty, and present-with-length. Missing fields report as
// missing instead of crashing; no content, refusal text, tool arguments,
// reasoning text, prompt, or URL ever reaches the log.
export function describeDecisionFailure(response: DecisionFailureResponse): string {
	const choices = Array.isArray(response?.choices) ? response.choices : [];
	const choice = choices[0];
	const finishText = describeFinishReason(choice?.finish_reason);
	const message = choice?.message ?? null;
	const record = message !== null && typeof message === "object" ? message : null;
	let contentText = "missing";
	if (record && "content" in record) {
		const content = record.content;
		if (typeof content === "string") contentText = content.length ? `present ${content.length} chars` : "empty";
		else if (content === null) contentText = "null";
		else if (content !== undefined) contentText = "unlisted";
	}
	const refusal = record ? record.refusal : undefined;
	const refusalText = typeof refusal === "string" && refusal.length ? `${refusal.length} chars` : "none";
	const tools = record && Array.isArray(record.tool_calls) ? record.tool_calls.length : 0;
	const usage = response?.usage;
	let usageText = "none";
	if (usage !== null && typeof usage === "object") {
		const parts: string[] = [];
		const numeric = (label: string, value: unknown) => {
			if (typeof value === "number") parts.push(`${label} ${value}`);
		};
		numeric("prompt", usage.prompt_tokens);
		numeric("completion", usage.completion_tokens);
		numeric("total", usage.total_tokens);
		const details = usage.completion_tokens_details;
		if (details !== null && typeof details === "object") numeric("reasoning", details.reasoning_tokens);
		if (parts.length) usageText = `[${parts.join(", ")}]`;
	}
	return `choices ${choices.length}, finish ${finishText}, content ${contentText}, refusal ${refusalText}, tool calls ${tools}, usage ${usageText}`;
}
