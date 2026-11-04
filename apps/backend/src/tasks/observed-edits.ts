import type { ConversationMessage, ConversationSnapshot } from "@envoy/contracts";

export type ObservedEdit = {
	before: string;
	after: string;
	direction: ConversationMessage["direction"];
	sender: string | null;
};

function editedMessageLabel(edit: ObservedEdit): string {
	switch (edit.direction) {
		case "incoming":
			return edit.sender ? `incoming message from ${edit.sender}` : "incoming message";
		case "outgoing":
			return "outgoing message";
		case "unknown":
			return "message with unknown sender";
		default:
			return "message";
	}
}

// Untrusted conversation history, like the conversation itself. The current
// text in the snapshot is the sender's statement; the previous text is only
// what it said before.
export function describeEdit(edit: ObservedEdit): { text: string; body: string } {
	const who = editedMessageLabel(edit);
	const article = /^[aeiou]/i.test(who) ? "An" : "A";
	return {
		text: `${article} ${who} was corrected (not a new message).`,
		body: `Previous text: ${edit.before}\nCurrent text: ${edit.after}`,
	};
}

function stableKey(message: ConversationMessage): string | null {
	const stable = message.stableId?.trim();
	return stable ? stable : null;
}

// Plain text messages only. Captions and attachment edits were not tested,
// so messages with attachments, withdrawals, and system events are never
// matched for before/after text.
function trackable(message: ConversationMessage): string | null {
	const stable = stableKey(message);
	if (!stable || message.attachments.length || message.unsent || message.direction === "system") return null;
	return stable;
}

function stableCounts(snapshot: ConversationSnapshot): Map<string, number> {
	const counts = new Map<string, number>();
	for (const message of snapshot.messages) {
		const stable = stableKey(message);
		if (!stable) continue;
		counts.set(stable, (counts.get(stable) ?? 0) + 1);
	}
	return counts;
}

export function findEdits(lastSeen: ReadonlyMap<string, string>, snapshot: ConversationSnapshot): ObservedEdit[] {
	const counts = stableCounts(snapshot);
	const edits: ObservedEdit[] = [];
	for (const message of snapshot.messages) {
		const stable = trackable(message);
		if (!stable || counts.get(stable) !== 1) continue;
		const before = lastSeen.get(stable);
		if (before === undefined || before === message.text) continue;
		edits.push({ before, after: message.text, direction: message.direction, sender: message.sender ?? null });
	}
	return edits;
}

export function recordSeenTexts(lastSeen: Map<string, string>, snapshot: ConversationSnapshot): void {
	const counts = stableCounts(snapshot);
	for (const message of snapshot.messages) {
		const stable = stableKey(message);
		if (!stable || counts.get(stable) !== 1) {
			if (stable) lastSeen.delete(stable);
			continue;
		}
		const tracked = trackable(message);
		if (!tracked) {
			lastSeen.delete(stable);
			continue;
		}
		lastSeen.set(tracked, message.text);
	}
}
