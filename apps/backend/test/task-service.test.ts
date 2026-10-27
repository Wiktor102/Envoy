import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentDecision, ConversationMessage, ConversationSnapshot } from "@envoy/contracts";
import type { Agent } from "../src/agent/agent.js";
import { TaskService } from "../src/tasks/service.js";
import { allowedOrigin } from "../src/origin.js";

function snapshot(
	revision = "r1",
	text = "Can we meet?",
	direction: ConversationMessage["direction"] = "incoming",
): ConversationSnapshot {
	return {
		chatId: "chat-1",
		revision,
		messages: [{ id: "node-1", text, direction, replyTo: null, attachments: [], reactions: [] }],
	};
}

class ControlledAgent implements Agent {
	calls: {
		snapshot: ConversationSnapshot;
		signal: AbortSignal | undefined;
		resolve: (decision: AgentDecision) => void;
	}[] = [];
	run(_task: unknown, conversation: ConversationSnapshot, signal?: AbortSignal): Promise<AgentDecision> {
		return new Promise((resolve) => this.calls.push({ snapshot: conversation, signal, resolve }));
	}
}

function setup() {
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

async function resolveReply(agent: ControlledAgent, index = 0, text = "Tuesday works.") {
	agent.calls[index]!.resolve({ action: "reply", text });
	await Promise.resolve();
}

test("changed messages invalidate old generation and late results", async () => {
	const { agent, service, advance } = setup();
	const start = service.start("owner", "Arrange a meeting", snapshot());
	assert.equal(start.status, "thinking");
	service.sync("owner", snapshot("r2", "Thursday instead?"));
	assert.equal(agent.calls.length, 2);
	assert.equal(agent.calls[0]!.signal?.aborted, true);
	await resolveReply(agent, 0, "stale");
	assert.equal(service.sync("owner", snapshot("r2", "Thursday instead?")).task?.pendingReply, null);
	await resolveReply(agent, 1, "Thursday works.");
	assert.equal(service.sync("owner", snapshot("r2", "Thursday instead?")).task?.pendingReply?.expectedRevision, "r2");
	advance(9_999);
	assert.equal(service.sync("owner", snapshot("r2", "Thursday instead?")).command, null);
	advance(1);
	assert.equal(service.sync("owner", snapshot("r2", "Thursday instead?")).command?.text, "Thursday works.");
});

test("a claim can be revoked for editing, and the new reply waits for Send now", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.ok(claim);
	assert.equal(service.sync("owner", snapshot()).command, null);
	const editing = service.control("owner", task.id, "edit");
	assert.equal(editing.status, "editing");
	assert.equal(editing.pendingReply?.sendAt, null);
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), false);
	const saved = service.control("owner", task.id, "save-edit", "Thursday is better.");
	assert.equal(saved.pendingReply?.sendAt, null);
	advance(20_000);
	assert.equal(service.sync("owner", snapshot()).command, null);
	service.control("owner", task.id, "send-now");
	assert.equal(service.sync("owner", snapshot()).command, null);
	service.report("owner", claim.commandId, "rejected");
	const newClaim = service.sync("owner", snapshot()).command!;
	assert.notEqual(newClaim.commandId, claim.commandId);
	assert.equal(newClaim.text, "Thursday is better.");
	assert.equal(service.authorize("owner", newClaim.commandId, newClaim.chatId, newClaim.expectedRevision), true);
	assert.equal(service.authorize("owner", newClaim.commandId, newClaim.chatId, newClaim.expectedRevision), false);
	assert.equal(service.report("owner", newClaim.commandId, "sent")?.status, "waiting");
	assert.equal(service.report("owner", newClaim.commandId, "sent")?.status, "waiting");
	assert.equal(service.sync("owner", snapshot()).command, null);
	assert.equal(agent.calls.length, 1);
});

test("a rejected retired claim does not suppress a paused edit on resume", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	service.control("owner", task.id, "edit");
	service.report("owner", claim.commandId, "rejected");
	service.control("owner", task.id, "pause");
	assert.equal(service.control("owner", task.id, "resume").status, "thinking");
	assert.equal(agent.calls.length, 2);
});

test("resuming an unauthorized claim waits for rejection before regenerating", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	service.control("owner", task.id, "pause");
	assert.equal(service.control("owner", task.id, "resume").status, "waiting");
	assert.equal(agent.calls.length, 1);
	service.report("owner", claim.commandId, "rejected");
	assert.equal(service.sync("owner", snapshot()).task?.status, "thinking");
	assert.equal(agent.calls.length, 2);
});

test("a late uncertain retired claim cancels a replacement edit and requires review", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	service.control("owner", task.id, "edit");
	service.control("owner", task.id, "save-edit", "Thursday works.");
	service.control("owner", task.id, "send-now");
	assert.equal(service.sync("owner", snapshot()).command, null);
	const state = service.report("owner", claim.commandId, "uncertain")!;
	assert.equal(state.status, "needs_user");
	assert.equal(state.pendingReply, null);
	assert.match(state.detail!, /may have completed/);
	assert.equal(service.sync("owner", snapshot()).command, null);
	assert.equal(service.control("owner", task.id, "resume").status, "waiting");
	assert.equal(agent.calls.length, 1);
});

test("a retired claim gates takeover, replacement tasks, and deletion until its result", async () => {
	for (const result of ["rejected", "uncertain", "sent"] as const) {
		const { agent, service, advance } = setup();
		const task = service.start("owner", "Arrange a meeting", snapshot());
		await resolveReply(agent);
		advance(10_000);
		const claim = service.sync("owner", snapshot()).command!;
		const takenOver = service.control("owner", task.id, "take-over");
		assert.equal(takenOver.status, "taken_over");
		assert.match(takenOver.detail!, /Checking/);
		assert.throws(() => service.start("owner", "Try again", snapshot()), /still being checked/);
		assert.throws(() => service.clear("owner", task.id), /still being checked/);
		const reported = service.report("owner", claim.commandId, result)!;
		assert.equal(reported.status, "taken_over");
		if (result === "rejected") {
			assert.equal(service.start("owner", "Try again", snapshot()).status, "thinking");
		} else {
			assert.match(reported.detail!, /may have completed/);
			assert.throws(() => service.start("owner", "Try again", snapshot()), /previous send may have completed/);
		}
	}
});

test("a lost retired report expires to uncertainty without allowing a replacement send", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	service.control("owner", task.id, "edit");
	service.control("owner", task.id, "save-edit", "Thursday works.");
	service.control("owner", task.id, "send-now");
	advance(30_001);
	const expired = service.sync("owner", snapshot());
	assert.equal(expired.command, null);
	assert.equal(expired.task?.status, "needs_user");
	assert.match(expired.task?.detail!, /may have completed/);
	assert.equal(service.report("owner", claim.commandId, "rejected")?.status, "needs_user");
});

test("a lost retired report after takeover blocks a new task until the user reviews it", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	service.sync("owner", snapshot());
	service.control("owner", task.id, "take-over");
	advance(30_001);
	const state = service.sync("owner", snapshot()).task!;
	assert.equal(state.status, "taken_over");
	assert.match(state.detail!, /may have completed/);
	assert.throws(() => service.start("owner", "Try again", snapshot()), /previous send may have completed/);
	service.clear("owner", task.id);
	assert.equal(service.start("owner", "Try again", snapshot()).status, "thinking");
});

test("the original connector can settle a retired claim after a replacement attaches", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("old-owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("old-owner", snapshot()).command!;
	service.control("old-owner", task.id, "pause");
	service.disconnect("old-owner");
	assert.equal(service.attach("new-owner", task.id, snapshot()).status, "paused");
	assert.equal(service.control("new-owner", task.id, "resume").status, "waiting");
	assert.equal(service.report("old-owner", claim.commandId, "uncertain"), null);
	const state = service.sync("new-owner", snapshot()).task!;
	assert.equal(state.status, "needs_user");
	assert.match(state.detail!, /may have completed/);
	assert.equal(agent.calls.length, 1);
});

test("cancel does not regenerate from the same conversation or cosmetic changes", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	assert.equal(service.control("owner", task.id, "cancel").status, "waiting");
	service.sync("owner", snapshot());
	const changedReaction = snapshot("r2");
	changedReaction.messages[0]!.reactions = [{ label: "one reaction", emojis: ["👍"], count: 1 }];
	service.sync("owner", changedReaction);
	assert.equal(agent.calls.length, 1);
	service.sync("owner", snapshot("r3", "Thursday instead?"));
	assert.equal(agent.calls.length, 2);
});

test("explicit resume regenerates an unsent reply discarded by pause or disconnect", async () => {
	for (const action of ["pause", "disconnect"] as const) {
		const { agent, service } = setup();
		const task = service.start("owner", "Arrange a meeting", snapshot());
		await resolveReply(agent);
		assert.equal(service.sync("owner", snapshot()).task?.status, "pending");
		if (action === "pause") {
			assert.equal(service.control("owner", task.id, "pause").status, "paused");
		} else {
			service.disconnect("owner");
			assert.equal(service.sync("owner", snapshot()).task?.status, "paused");
		}
		assert.equal(service.control("owner", task.id, "resume").status, "thinking");
		assert.equal(agent.calls.length, 2);
		await resolveReply(agent, 1);
		assert.equal(service.sync("owner", snapshot()).task?.status, "pending");
	}
});

test("authorized sends cancelled or edited by the owner remain uncertain", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	const result = service.control("owner", task.id, "edit");
	assert.equal(result.status, "needs_user");
	assert.match(result.detail!, /may have completed/);
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), false);
	service.control("owner", task.id, "resume");
	service.sync("owner", snapshot());
	assert.equal(agent.calls.length, 1);
});

test("the outgoing bubble can arrive before the confirmed send report", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	const outgoing = snapshot("r2", "Tuesday works.", "outgoing");
	assert.equal(service.sync("owner", outgoing).task?.status, "sending");
	assert.equal(service.report("owner", claim.commandId, "sent")?.status, "waiting");
	assert.equal(service.sync("owner", outgoing).task?.status, "waiting");
	assert.equal(agent.calls.length, 1);
	service.sync("owner", snapshot("r3", "What time?"));
	assert.equal(agent.calls.length, 2);
	assert.equal(task.chatId, "chat-1");
});

test("send reports suppress the original text context after the visible snapshot changes", async () => {
	for (const result of ["sent", "rejected", "uncertain"] as const) {
		const { agent, service, advance } = setup();
		const task = service.start("owner", "Arrange a meeting", snapshot());
		await resolveReply(agent);
		advance(10_000);
		const claim = service.sync("owner", snapshot()).command!;
		assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
		service.sync("owner", snapshot("outgoing", "Tuesday works.", "outgoing"));
		service.report("owner", claim.commandId, result);
		const restored = snapshot("original-with-reaction");
		restored.messages[0]!.reactions = [{ label: "one reaction", emojis: ["👍"], count: 1 }];
		service.sync("owner", restored);
		if (result !== "sent") service.control("owner", task.id, "resume");
		assert.equal(service.sync("owner", restored).task?.status, "waiting");
		assert.equal(agent.calls.length, 1);
	}
});

test("uncertain invalidation suppresses the original text context after the snapshot changes", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	service.sync("owner", snapshot("outgoing", "Tuesday works.", "outgoing"));
	assert.equal(service.control("owner", task.id, "pause").status, "paused");
	const restored = snapshot("original-with-reaction");
	restored.messages[0]!.reactions = [{ label: "one reaction", emojis: ["👍"], count: 1 }];
	service.sync("owner", restored);
	assert.equal(service.control("owner", task.id, "resume").status, "waiting");
	assert.equal(agent.calls.length, 1);
});

test("lost report and expired lease pause the task; attach requires the same chat", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("old-owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("old-owner", snapshot()).command!;
	assert.throws(() => service.attach("replacement", task.id, snapshot()));
	advance(100_001);
	const paused = service.sync("replacement", null);
	assert.equal(paused.isOwner, false);
	assert.equal(paused.task?.status, "paused");
	assert.equal(paused.task?.goal, "");
	assert.equal(paused.task?.pendingReply, null);
	assert.throws(() => service.attach("replacement", task.id, { ...snapshot(), chatId: "wrong" }));
	const attached = service.attach("replacement", task.id, snapshot());
	assert.equal(attached.status, "paused");
	assert.match(attached.detail!, /may have completed/);
	assert.equal(service.authorize("old-owner", claim.commandId, claim.chatId, claim.expectedRevision), false);
	service.control("replacement", task.id, "resume");
	service.sync("replacement", snapshot());
	assert.equal(agent.calls.length, 1);
});

test("a lost send report becomes uncertain even while the connector keeps checking in", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	advance(30_001);
	const result = service.sync("owner", snapshot());
	assert.equal(result.task?.status, "needs_user");
	assert.match(result.task?.detail!, /could not be confirmed/);
	assert.equal(service.report("owner", claim.commandId, "sent")?.status, "needs_user");
	service.control("owner", task.id, "update-goal", "Arrange Thursday instead");
	assert.equal(service.sync("owner", snapshot()).task?.status, "needs_user");
	assert.equal(agent.calls.length, 1);
});

test("another tab cannot disconnect, submit snapshots, or control the owner task", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Private goal", snapshot());
	await resolveReply(agent);
	const before = service.sync("owner", snapshot()).task;
	const other = service.sync("other", null);
	assert.equal(other.isOwner, false);
	assert.equal(other.task?.goal, "");
	assert.equal(other.task?.pendingReply, null);
	service.disconnect("other");
	assert.throws(() => service.control("other", task.id, "pause"));
	assert.deepEqual(service.sync("owner", snapshot()).task, before);
});

test("unknown direction, unsupported content and an outgoing last message do not trigger the model", () => {
	{
		const { agent, service } = setup();
		const result = service.start("owner", "Arrange a meeting", snapshot("r1", "Hello", "unknown"));
		assert.equal(result.status, "needs_user");
		assert.equal(agent.calls.length, 0);
	}
	{
		const { agent, service } = setup();
		const content = snapshot();
		content.messages[0]!.attachments = [{ type: "image", url: null, description: null }];
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.equal(agent.calls.length, 0);
	}
	{
		const { agent, service } = setup();
		const result = service.start("owner", "Arrange a meeting", snapshot("r1", "Hello", "outgoing"));
		assert.equal(result.status, "waiting");
		assert.equal(agent.calls.length, 0);
	}
});

test("known incoming text can be considered with incomplete older history", async () => {
	const { agent, service } = setup();
	const current = snapshot("r1", "Does Tuesday work?");
	const older: ConversationMessage = {
		id: "older",
		text: "See this",
		direction: "unknown",
		attachments: [{ type: "image", url: null, description: null }],
		replyTo: { text: null, context: null, attachments: [] },
		reactions: [],
	};
	const withHistory = { ...current, messages: [older, ...current.messages] };
	const task = service.start("owner", "Arrange a meeting", withHistory);
	assert.equal(task.status, "thinking");
	assert.deepEqual(agent.calls[0]!.snapshot.messages[0], older);
	agent.calls[0]!.resolve({ action: "ask", text: "Is the earlier photo relevant to Tuesday?" });
	await Promise.resolve();
	const result = service.sync("owner", withHistory);
	assert.equal(result.task?.status, "needs_user");
	assert.equal(result.task?.detail, "Is the earlier photo relevant to Tuesday?");
	assert.equal(result.command, null);
});

test("takeover ignores a late model response", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	service.control("owner", task.id, "take-over");
	await resolveReply(agent);
	const result = service.sync("owner", snapshot());
	assert.equal(result.task?.status, "taken_over");
	assert.equal(result.command, null);
});

test("model decisions asking the user, waiting and finishing do not schedule a reply", async () => {
	for (const decision of [
		{ action: "wait" } as const,
		{ action: "ask", text: "Is Thursday available?" } as const,
		{ action: "finish", text: "Meeting agreed." } as const,
	]) {
		const { agent, service } = setup();
		service.start("owner", "Arrange a meeting", snapshot());
		agent.calls[0]!.resolve(decision);
		await Promise.resolve();
		const state = service.sync("owner", snapshot());
		assert.equal(state.command, null);
		assert.equal(
			state.task?.status,
			decision.action === "ask" ? "needs_user" : decision.action === "finish" ? "completed" : "waiting",
		);
	}
});

test("control characters are rejected in replies but allowed in the user's goal", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting\nAvoid Friday.", snapshot());
	await resolveReply(agent);
	service.control("owner", task.id, "edit");
	assert.throws(() => service.control("owner", task.id, "save-edit", "First line\nSecond line"), /single line/);
	assert.equal(service.sync("owner", snapshot()).task?.status, "editing");
});

test("owned terminal tasks can be deleted, including their snapshot and conversation state", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	assert.throws(() => service.clear("owner", task.id));
	service.control("owner", task.id, "take-over");
	assert.throws(() => service.clear("other", task.id));
	service.clear("owner", task.id);
	assert.equal(service.sync("owner", snapshot()).task, null);
	await resolveReply(agent);
	assert.equal(service.sync("owner", snapshot()).task, null);
});

test("a replacement task cannot silently retry an uncertain send in the same chat", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const command = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", command.commandId, command.chatId, command.expectedRevision), true);
	service.control("owner", task.id, "take-over");
	assert.throws(() => service.start("owner", "Arrange it another way", snapshot()), /previous send may have completed/);
	assert.throws(() => service.clear("other", task.id));
	assert.equal(agent.calls.length, 1);
	advance(100_001);
	service.clear("other", task.id);
	assert.equal(service.start("other", "Arrange it another way", snapshot()).status, "thinking");
});

test("browser origins other than Chrome extensions cannot reach the WebSocket", () => {
	assert.equal(allowedOrigin(undefined), true);
	assert.equal(allowedOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"), true);
	assert.equal(allowedOrigin("https://example.com"), false);
	assert.equal(allowedOrigin("http://127.0.0.1:3001"), false);
	assert.equal(allowedOrigin("null"), false);
	assert.equal(allowedOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop.evil.example"), false);
});

test("system events remain context, invalidate pending replies, and do not hide unknown senders", async () => {
	const { agent, service } = setup();
	const initial = snapshot();
	service.start("owner", "Arrange a meeting", initial);
	await resolveReply(agent);
	const event: ConversationMessage = {
		id: "event",
		text: "Group renamed",
		direction: "system",
		replyTo: null,
		attachments: [],
		reactions: [],
	};
	const changed = { ...initial, revision: "r2", messages: [...initial.messages, event] };
	assert.equal(service.sync("owner", changed).task?.pendingReply, null);
	assert.equal(agent.calls.length, 2);
	assert.equal(agent.calls[1]!.snapshot.messages.at(-1)?.direction, "system");
	const unknown = {
		...snapshot("r3", "Who sent this?", "unknown"),
		messages: [...snapshot("r3", "Who sent this?", "unknown").messages, event],
	};
	assert.equal(service.sync("owner", unknown).task?.status, "needs_user");
	assert.equal(agent.calls.length, 2);
});
