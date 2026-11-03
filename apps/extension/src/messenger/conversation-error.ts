export class ConversationUnavailableError extends Error {
	constructor(public readonly reason: "no-chat" | "not-ready" | "not-latest" | "unsupported" | "changed" | "navigated") {
		super(reason);
	}
}
