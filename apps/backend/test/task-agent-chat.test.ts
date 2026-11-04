import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationMessage, ConversationSnapshot, TaskState } from "@envoy/contracts";
import { resolveReply, setup, snapshot } from "./support/task-fixtures.js";

function stableSnapshot(
	revision: string,
	entries: Array<{
		stableId: string;
		text: string;
		direction?: ConversationMessage["direction"];
		edited?: boolean | null;
	}>,
): ConversationSnapshot {
	return {
		chatId: "chat-1",
		revision,
		messages: entries.map(({ stableId, text, direction = "incoming", edited = false }, index) => ({
			id: `node-${index}`,
			stableId,
			edited,
			text,
			direction,
			sender: null,
			replyTo: null,
			attachments: [],
			reactions: [],
			unsent: false,
		})),
		participants: [],
	};
}

test("agent questions and user answers accumulate as task-local history", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	agent.calls[0]!.resolve({ action: "ask", text: "Is Friday allowed?" });
	await Promise.resolve();
	const asked = service.sync("owner", snapshot()).task!;
	assert.equal(asked.status, "needs_user");
	assert.equal(asked.agentChat.length, 1);
	assert.equal(asked.agentChat[0]!.role, "agent");
	assert.equal(asked.agentChat[0]!.text, "Is Friday allowed?");
	assert.ok(asked.agentChat[0]!.id);

	const answered = service.control("owner", task.id, "answer-agent", "Yes, after 3.");
	assert.equal(answered.status, "thinking");
	assert.equal(answered.goal, "Arrange a meeting");
	assert.equal(answered.agentChat.length, 2);
	assert.equal(answered.agentChat[1]!.role, "user");
	assert.equal(answered.agentChat[1]!.text, "Yes, after 3.");
	assert.equal(agent.calls.length, 2);
	assert.deepEqual(
		agent.calls[1]!.task.agentChat.map(({ role, text }) => ({ role, text })),
		[
			{ role: "agent", text: "Is Friday allowed?" },
			{ role: "user", text: "Yes, after 3." },
		],
	);
});

test("answering the agent cancels a pending reply and re-evaluates", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	assert.equal(service.sync("owner", snapshot()).task?.status, "pending");
	const answered = service.control("owner", task.id, "answer-agent", "Mention Thursday instead.");
	assert.equal(answered.pendingReply, null);
	assert.equal(answered.status, "thinking");
	assert.equal(agent.calls.length, 2);
	assert.equal(agent.calls[1]!.reason, "instructions_updated");
});

test("reply sends, edits, and cancellations are recorded for the model", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	service.control("owner", task.id, "edit");
	service.control("owner", task.id, "save-edit", "Thursday works.");
	service.control("owner", task.id, "send-now");
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	const sent = service.report("owner", claim.commandId, "sent")!;
	assert.deepEqual(
		sent.agentChat.map(({ role, text }) => ({ role, text })),
		[
			{ role: "event", text: "Reply edited to: Thursday works." },
			{ role: "event", text: "Reply sent." },
		],
	);
	assert.equal(sent.agentChat.find((entry) => entry.text === "Reply sent.")?.body, "Thursday works.");
	service.sync("owner", snapshot("r2", "What time?"));
	assert.equal(agent.calls[1]!.signal?.aborted, true);
	assert.equal(agent.calls[2]!.reason, "new_message");
	await resolveReply(agent, 2, "After 3.");
	assert.equal(service.control("owner", task.id, "cancel").agentChat.at(-1)?.text, "Reply cancelled.");
	service.sync("owner", snapshot("r3", "Friday instead?"));
	assert.ok(agent.calls[3]!.task.agentChat.some((entry) => entry.text === "Reply sent."));
	assert.ok(agent.calls[3]!.task.agentChat.some((entry) => entry.text === "Reply cancelled."));
});

test("other tabs receive no agent chat history", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Private goal", snapshot());
	agent.calls[0]!.resolve({ action: "ask", text: "Is Friday allowed?" });
	await Promise.resolve();
	service.control("owner", task.id, "answer-agent", "Yes.");
	const other = service.sync("other", null);
	assert.equal(other.isOwner, false);
	assert.equal(other.task?.goal, "");
	assert.deepEqual(other.task?.agentChat, []);
	assert.equal(service.sync("owner", snapshot()).task?.agentChat.length, 2);
});

test("agent chat history keeps only recent entries", () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	for (let i = 0; i < 60; i++) {
		service.control("owner", task.id, "answer-agent", `Guidance ${i}.`);
	}
	const state = service.sync("owner", snapshot()).task!;
	assert.equal(state.agentChat.length, 50);
	assert.equal(state.agentChat[0]!.text, "Guidance 10.");
	assert.equal(agent.calls.length, 61);
});

test("answering an ended task is rejected", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	agent.calls[0]!.resolve({ action: "finish", text: "Meeting agreed." });
	await Promise.resolve();
	const completed = service.sync("owner", snapshot()).task!;
	assert.equal(completed.status, "completed");
	assert.deepEqual(
		completed.agentChat.map(({ role, text }) => ({ role, text })),
		[{ role: "agent", text: "Meeting agreed." }],
	);
	assert.throws(() => service.control("owner", task.id, "answer-agent", "Thanks."), /has ended/);
});

test("observed edits reach the agent once with before/after text, including repeated edits", async () => {
	const { agent, service } = setup();
	service.start("owner", "Arrange a meeting", stableSnapshot("r1", [{ stableId: "m1", text: "alpha" }]));
	agent.calls[0]!.resolve({ action: "wait" });
	await Promise.resolve();
	service.sync("owner", stableSnapshot("r1", [{ stableId: "m1", text: "alpha" }]));
	assert.equal(agent.calls.length, 1);

	const beta = stableSnapshot("r2", [{ stableId: "m1", text: "beta", edited: true }]);
	service.sync("owner", beta);
	assert.equal(agent.calls.length, 2);
	assert.equal(agent.calls[1]!.reason, "message_edited");
	const first = agent.calls[1]!.task.agentChat.at(-1)!;
	assert.equal(first.role, "event");
	assert.match(first.text, /corrected.*not a new message/);
	assert.match(first.body!, /alpha/);
	assert.match(first.body!, /beta/);

	// Same revision never re-emits.
	service.sync("owner", beta);
	assert.equal(agent.calls.length, 2);

	// Repeated edit chains from the last observed text.
	const gamma = stableSnapshot("r3", [{ stableId: "m1", text: "gamma", edited: true }]);
	service.sync("owner", gamma);
	assert.equal(agent.calls.length, 3);
	assert.equal(agent.calls[2]!.reason, "message_edited");
	const second = agent.calls[2]!.task.agentChat.at(-1)!;
	assert.match(second.body!, /beta/);
	assert.match(second.body!, /gamma/);
	assert.doesNotMatch(second.body!, /alpha/);
});

test("edits stop a pending reply and trigger even when the latest message is outgoing", async () => {
	const { agent, service, advance } = setup();
	const initial = stableSnapshot("r1", [
		{ stableId: "m1", text: "Tuesday works" },
		{ stableId: "m2", text: "Great, see you then.", direction: "outgoing" },
	]);
	service.start("owner", "Arrange a meeting", initial);
	await resolveReply(agent);
	assert.equal(service.sync("owner", initial).task?.status, "pending");

	// Edit to the older incoming message during the countdown.
	const edited = stableSnapshot("r2", [
		{ stableId: "m1", text: "Thursday works", edited: true },
		{ stableId: "m2", text: "Great, see you then.", direction: "outgoing" },
	]);
	const result = service.sync("owner", edited);
	assert.equal(result.task?.pendingReply, null);
	assert.equal(result.command, null);
	assert.equal(agent.calls.length, 2);
	assert.equal(agent.calls[1]!.reason, "message_edited");
	assert.match(agent.calls[1]!.task.agentChat.at(-1)!.body!, /Tuesday works/);
	assert.match(agent.calls[1]!.task.agentChat.at(-1)!.body!, /Thursday works/);

	// Outgoing latest alone still waits; the edit was the trigger.
	advance(10_000);
	assert.equal(service.sync("owner", edited).command, null);
});

test("remounts, partial history, and already-edited messages never invent edits", async () => {
	const { agent, service } = setup();
	const full = stableSnapshot("r1", [
		{ stableId: "m1", text: "First" },
		{ stableId: "m2", text: "Second" },
	]);
	service.start("owner", "Arrange a meeting", full);
	agent.calls[0]!.resolve({ action: "wait" });
	await Promise.resolve();
	service.sync("owner", full);
	assert.equal(agent.calls.length, 1);

	const editedReasons = () => agent.calls.filter((call) => call.reason === "message_edited").length;
	const correctionsIn = (task: TaskState | null) =>
		(task?.agentChat ?? []).filter(({ text }) => /corrected/.test(text)).length;

	// Remount keeps the content revision: same texts, new node IDs, no edits.
	const remounted = stableSnapshot("r1", [
		{ stableId: "m1", text: "First" },
		{ stableId: "m2", text: "Second" },
	]);
	remounted.messages[0]!.id = "new-node-0";
	remounted.messages[1]!.id = "new-node-1";
	assert.equal(correctionsIn(service.sync("owner", remounted).task), 0);
	assert.equal(editedReasons(), 0);

	// Partial history then the full window: newly seen messages are not edits.
	const partial = stableSnapshot("r1b", [{ stableId: "m2", text: "Second" }]);
	assert.equal(correctionsIn(service.sync("owner", partial).task), 0);
	assert.equal(correctionsIn(service.sync("owner", full).task), 0);
	assert.equal(editedReasons(), 0);

	// First sight of an already-edited message has no previous version.
	const alreadyEdited = stableSnapshot("r2", [
		{ stableId: "m1", text: "First" },
		{ stableId: "m2", text: "Second" },
		{ stableId: "m3", text: "Corrected text", edited: true },
	]);
	assert.equal(correctionsIn(service.sync("owner", alreadyEdited).task), 0);
	assert.equal(editedReasons(), 0);
	assert.equal(agent.calls.at(-1)!.snapshot.messages.at(-1)!.edited, true);

	// Duplicate stable IDs never match fail-closed.
	const duplicated = stableSnapshot("r3", [
		{ stableId: "m1", text: "First changed" },
		{ stableId: "m1", text: "First changed" },
	]);
	assert.equal(correctionsIn(service.sync("owner", duplicated).task), 0);
	assert.equal(editedReasons(), 0);

	// Captions and attachment edits stay unsupported rather than inferred.
	const captioned = stableSnapshot("r4", [{ stableId: "m1", text: "First edited caption" }]);
	captioned.messages[0]!.attachments = [{ type: "image", url: null, description: null, media: null }];
	assert.equal(correctionsIn(service.sync("owner", captioned).task), 0);
	assert.equal(editedReasons(), 0);
});
