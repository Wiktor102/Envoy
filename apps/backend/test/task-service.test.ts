import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentDecision, ConversationMessage, ConversationSnapshot, TaskState } from "@envoy/contracts";
import type { Agent, EvaluationReason } from "../src/agent/agent.js";
import { ExtensionConnector } from "../src/connectors/extension-connector.js";
import { TaskService } from "../src/tasks/service.js";
import { allowedOrigin } from "../src/origin.js";

function snapshot(
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

class ControlledAgent implements Agent {
	calls: {
		task: TaskState;
		snapshot: ConversationSnapshot;
		reason: EvaluationReason;
		signal: AbortSignal | undefined;
		resolve: (decision: AgentDecision) => void;
	}[] = [];
	run(
		task: TaskState,
		conversation: ConversationSnapshot,
		reason: EvaluationReason,
		signal?: AbortSignal,
	): Promise<AgentDecision> {
		return new Promise((resolve) => this.calls.push({ task, snapshot: conversation, reason, signal, resolve }));
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

test("Dev mode prefixes the pending preview and send command", async () => {
	const { agent, service, advance } = setup();
	service.start("owner", "Arrange a meeting", snapshot(), true);
	await resolveReply(agent);
	assert.equal(service.sync("owner", snapshot()).task?.pendingReply?.text, "> Tuesday works.");
	advance(10_000);
	assert.equal(service.sync("owner", snapshot()).command?.text, "> Tuesday works.");
});

test("only the owner can change Dev mode for future generated replies", async () => {
	const { agent, service } = setup();
	service.start("owner", "Arrange a meeting", snapshot(), true);
	service.sync("other", snapshot(), false);
	await resolveReply(agent);
	assert.equal(service.sync("owner", snapshot()).task?.pendingReply?.text, "> Tuesday works.");
	// Switching off leaves a pending reply intact, then affects the next generation.
	assert.equal(service.sync("owner", snapshot(), false).task?.pendingReply?.text, "> Tuesday works.");
	service.sync("owner", snapshot("r2", "Thursday instead?"), false);
	await resolveReply(agent, 1, "Thursday works.");
	assert.equal(service.sync("owner", snapshot("r2", "Thursday instead?")).task?.pendingReply?.text, "Thursday works.");
	service.sync("owner", snapshot("r3", "Friday instead?"), true);
	await resolveReply(agent, 2, "Friday works.");
	assert.equal(service.sync("owner", snapshot("r3", "Friday instead?")).task?.pendingReply?.text, "> Friday works.");
});

test("reply settings pick a random whole-second delay within the range", async () => {
	for (const [random, delay] of [
		[0, 5_000],
		[0.5, 10_000],
		[0.999, 15_000],
	] as const) {
		let time = 1_000;
		const agent = new ControlledAgent();
		const service = new TaskService(agent, { now: () => time, leaseMs: 100_000, random: () => random });
		const settings = { autoSend: true, minDelaySeconds: 5, maxDelaySeconds: 15 };
		service.start("owner", "Arrange a meeting", snapshot(), false, settings);
		await resolveReply(agent);
		assert.equal(service.sync("owner", snapshot(), false, settings).task?.pendingReply?.sendAt, 1_000 + delay);
		time += delay - 1;
		assert.equal(service.sync("owner", snapshot(), false, settings).command, null);
		time += 1;
		assert.ok(service.sync("owner", snapshot(), false, settings).command);
	}
});

test("with auto-send off a reply waits for Send now", async () => {
	const { agent, service, advance } = setup();
	const settings = { autoSend: false, minDelaySeconds: 10, maxDelaySeconds: 10 };
	service.start("owner", "Arrange a meeting", snapshot(), false, settings);
	await resolveReply(agent);
	const { task } = service.sync("owner", snapshot(), false, settings);
	assert.equal(task?.status, "pending");
	assert.equal(task?.pendingReply?.sendAt, null);
	assert.equal(task?.detail, "Automatic sending is off. Choose Send now when it is ready.");
	advance(60_000);
	assert.equal(service.sync("owner", snapshot(), false, settings).command, null);
	service.control("owner", task!.id, "send-now");
	assert.equal(service.sync("owner", snapshot(), false, settings).command?.text, "Tuesday works.");
});

test("switching auto-send off stops only a running automatic countdown", async () => {
	const { agent, service, advance } = setup();
	const on = { autoSend: true, minDelaySeconds: 10, maxDelaySeconds: 10 };
	const off = { ...on, autoSend: false };
	const task = service.start("owner", "Arrange a meeting", snapshot(), false, on);
	await resolveReply(agent);
	assert.equal(service.sync("owner", snapshot(), false, on).task?.pendingReply?.sendAt, 11_000);
	advance(10_000);
	// The same sync that carries the change must not claim the due reply.
	const stopped = service.sync("owner", snapshot(), false, off);
	assert.equal(stopped.command, null);
	assert.equal(stopped.task?.pendingReply?.sendAt, null);
	// Switching back on does not restart a stopped countdown.
	advance(60_000);
	assert.equal(service.sync("owner", snapshot(), false, on).task?.pendingReply?.sendAt, null);
	// An explicit Send now is not stopped by auto-send being off.
	service.control("owner", task.id, "send-now");
	assert.ok(service.sync("owner", snapshot(), false, off).command);
});

test("connectors without reply settings keep the default countdown", async () => {
	const { agent, service } = setup();
	service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	assert.equal(service.sync("owner", snapshot()).task?.pendingReply?.sendAt, 11_000);
});

test("the Dev mode prefix counts toward the reply length limit", async () => {
	for (const length of [3998, 3999]) {
		const { agent, service } = setup();
		service.start("owner", "Arrange a meeting", snapshot(), true);
		await resolveReply(agent, 0, "a".repeat(length));
		const { task } = service.sync("owner", snapshot());
		if (length === 3998) assert.equal(task?.pendingReply?.text.length, 4000);
		else {
			assert.equal(task?.status, "needs_user");
			assert.equal(task?.pendingReply, null);
		}
	}
});

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

test("a rejected claim returns the reply for Send now instead of dropping it", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	const rejected = service.report("owner", claim.commandId, "rejected")!;
	assert.equal(rejected.status, "pending");
	assert.equal(rejected.pendingReply?.text, "Tuesday works.");
	assert.equal(rejected.pendingReply?.sendAt, null);
	assert.notEqual(rejected.pendingReply?.commandId, claim.commandId);
	advance(20_000);
	assert.equal(service.sync("owner", snapshot()).command, null);
	service.control("owner", task.id, "send-now");
	const retry = service.sync("owner", snapshot()).command!;
	assert.equal(retry.text, "Tuesday works.");
	assert.equal(service.authorize("owner", retry.commandId, retry.chatId, retry.expectedRevision), true);
	assert.equal(service.report("owner", retry.commandId, "sent")?.status, "waiting");
	assert.equal(agent.calls.length, 1);
});

test("Send now during an unauthorized claim retries once if the tab rejects it", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.control("owner", task.id, "send-now").status, "sending");
	assert.equal(service.report("owner", claim.commandId, "rejected")?.status, "pending");
	const retry = service.sync("owner", snapshot()).command!;
	assert.equal(retry.text, "Tuesday works.");
	assert.notEqual(retry.commandId, claim.commandId);
	const rejectedAgain = service.report("owner", retry.commandId, "rejected")!;
	assert.equal(rejectedAgain.status, "pending");
	assert.equal(rejectedAgain.pendingReply?.sendAt, null);
	assert.equal(service.sync("owner", snapshot()).command, null);
});

test("a rejected claim is not restored after the conversation changed", async () => {
	const { agent, service, advance } = setup();
	service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	service.sync("owner", snapshot("r2", "Actually, Friday?"));
	const state = service.report("owner", claim.commandId, "rejected")!;
	assert.equal(state.status, "needs_user");
	assert.equal(state.pendingReply, null);
	assert.match(state.detail!, /not sent/);
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

test("unknown direction and unsupported content do not trigger the model", () => {
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
	for (const attachments of [
		[{ type: "video", url: null, description: null, media: null }],
		[{ type: "sticker", url: null, description: null, media: null }],
		[{ type: "gif", url: null, description: null, media: null }],
		[{ type: "video", url: "https://example.test/clip.mp4", description: null, media: null }],
		[{ type: "file" }],
	]) {
		const { agent, service } = setup();
		const content = snapshot();
		content.messages[0]!.attachments = attachments as never;
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.equal(agent.calls.length, 0);
	}
});

test("readable photos trigger the model, including photo-only latest messages", () => {
	const media = { mime: "image/jpeg" as const, data: "AAAA", width: 4, height: 4 };
	{
		const { agent, service } = setup();
		const content = snapshot("r1", "");
		content.messages[0]!.attachments = [
			{ type: "image", url: "https://example.test/photo", description: null, media: null },
		];
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "thinking");
		assert.equal(agent.calls.length, 1);
	}
	{
		const { agent, service } = setup();
		const content = snapshot("r1", "What do you think?");
		content.messages[0]!.attachments = [
			{ type: "image", url: "https://example.test/one", description: null, media: null },
			{ type: "image", url: null, description: null, media },
		];
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "thinking");
		assert.equal(agent.calls.length, 1);
	}
});

test("readable GIFs, stickers, and framed videos trigger the model, files do not", () => {
	const media = { mime: "image/jpeg" as const, data: "AAAA", width: 4, height: 4 };
	for (const attachments of [
		[{ type: "gif", url: "https://example.test/clip", description: null, media: null }],
		[{ type: "sticker", url: "https://example.test/sticker", description: null, media: null }],
		[{ type: "gif", url: null, description: null, media }],
		[{ type: "sticker", url: null, description: null, media }],
		[{ type: "video", url: null, description: null, media }],
	]) {
		const { agent, service } = setup();
		const content = snapshot("r1", "");
		content.messages[0]!.attachments = attachments as never;
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "thinking");
		assert.equal(agent.calls.length, 1);
	}
	for (const attachments of [[{ type: "file" }], [{ type: "video", url: null, description: null, media: null }]]) {
		const { agent, service } = setup();
		const content = snapshot("r1", "See this");
		content.messages[0]!.attachments = attachments as never;
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.equal(agent.calls.length, 0);
	}
});

test("unreadable photos, other media, and quotes still pause for the user", () => {
	const media = { mime: "image/jpeg" as const, data: "AAAA", width: 4, height: 4 };
	const photo = { type: "image" as const, url: "https://example.test/photo", description: null, media: null };
	const cases: ConversationSnapshot["messages"][number][] = [
		// Bytes beyond reach stay presence-only.
		{
			...snapshot("r1", "See this").messages[0]!,
			attachments: [{ type: "image", url: null, description: null, media: null }],
		},
		{
			...snapshot("r1", "See this").messages[0]!,
			attachments: [{ type: "image", url: "http://example.test/photo", description: null, media: null }],
		},
		// Only photos forward bytes.
		{ ...snapshot("r1", "See this").messages[0]!, attachments: [{ type: "gif", url: null, description: null }] },
		{
			...snapshot("r1", "See this").messages[0]!,
			attachments: [photo, { type: "sticker", url: null, description: null }],
		},
		// Quote bytes stay client-side, so any quoted attachment pauses.
		{
			...snapshot("r1", "Nice").messages[0]!,
			attachments: [photo],
			replyTo: { text: "Original", context: "Reply", attachments: [photo] },
		},
	];
	for (const latest of cases) {
		const { agent, service } = setup();
		const content = { ...snapshot("r1"), messages: [latest] };
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.equal(agent.calls.length, 0);
	}
	// The fifth photo in one message falls past the snapshot cap.
	{
		const { agent, service } = setup();
		const local = { type: "image" as const, url: null, description: null, media };
		const content = snapshot("r1", "All five");
		content.messages[0]!.attachments = [local, local, local, local, local];
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.equal(agent.calls.length, 0);
	}
});

test("a quoted photo pauses with a specific message", () => {
	const photo = { type: "image" as const, url: "https://example.test/photo", description: null, media: null };
	{
		const { agent, service } = setup();
		const content = snapshot("r1", "What word is on this?");
		content.messages[0]!.replyTo = { text: null, context: null, attachments: [] };
		content.messages[0]!.attachments = [{ type: "video", url: null, description: null, media: null }];
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.equal(result.detail, "The latest message contains content Envoy cannot interpret.");
		assert.equal(agent.calls.length, 0);
	}
	{
		const { agent, service } = setup();
		const content = snapshot("r1", "What word is on this?");
		content.messages[0]!.replyTo = { text: "Original", context: "Reply", attachments: [photo] };
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.equal(result.detail, "The latest message quotes an image Envoy cannot read. Take over to reply yourself.");
		assert.equal(agent.calls.length, 0);
	}
	{
		const { agent, service } = setup();
		const content = snapshot("r1", "Funny, right?");
		content.messages[0]!.replyTo = {
			text: null,
			context: "Reply",
			attachments: [{ type: "gif", url: null, description: null, media: null }],
		};
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.equal(result.detail, "The latest message quotes media Envoy cannot read. Take over to reply yourself.");
		assert.equal(agent.calls.length, 0);
	}
});

test("a re-encoded photo at the same revision does not pause verification", async () => {
	const { agent, service } = setup();
	const first = snapshot("r1", "See this");
	first.messages[0]!.attachments = [
		{ type: "image", url: null, description: null, media: { mime: "image/jpeg", data: "AAAA", width: 4, height: 4 } },
	];
	service.start("owner", "Arrange a meeting", first);
	agent.calls[0]!.resolve({ action: "wait" });
	await Promise.resolve();
	const second = snapshot("r1", "See this");
	second.messages[0]!.attachments = [
		{ type: "image", url: null, description: null, media: { mime: "image/jpeg", data: "BBBB", width: 4, height: 4 } },
	];
	const result = service.sync("owner", second);
	assert.equal(result.task?.status, "waiting");
});

test("an unsent latest message, including an unsent group event, does not trigger the model", () => {
	{
		const { agent, service } = setup();
		const content = snapshot("r1", "");
		content.messages[0]!.unsent = true;
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.match(result.detail!, /unsent/);
		assert.equal(agent.calls.length, 0);
	}
	{
		const { agent, service } = setup();
		const content = snapshot("r1", "Can we meet?");
		content.messages.push({ ...content.messages[0]!, id: "node-2", text: "", direction: "system", unsent: true });
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
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
		unsent: false,
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
		unsent: false,
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

test("a transient unreadable view resumes the agent once the same chat reads again", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	const paused = service.sync("owner", null).task!;
	assert.equal(paused.status, "paused");
	assert.equal(paused.pendingReply, null);
	assert.match(paused.detail!, /resumes when it can read/);
	const resumed = service.sync("owner", snapshot()).task!;
	assert.equal(resumed.status, "thinking");
	assert.equal(agent.calls.length, 2);

	// A pause by the user, or while waiting for the user, is never lifted.
	agent.calls[1]!.resolve({ action: "ask", text: "Which day?" });
	await Promise.resolve();
	assert.equal(service.sync("owner", snapshot()).task?.status, "needs_user");
	service.sync("owner", null);
	assert.equal(service.sync("owner", snapshot()).task?.status, "paused");
	service.control("owner", task.id, "resume");
	assert.equal(agent.calls[2]!.reason, "user_resumed");
	service.sync("owner", null);
	service.control("owner", task.id, "pause");
	assert.equal(service.sync("owner", snapshot()).task?.status, "paused");
	assert.equal(agent.calls.length, 3);
});

test("an unreadable view does not resume a send that may have completed", async () => {
	for (const authorized of [false, true]) {
		const { agent, service, advance } = setup();
		service.start("owner", "Arrange a meeting", snapshot());
		await resolveReply(agent);
		advance(10_000);
		const claim = service.sync("owner", snapshot()).command!;
		if (authorized)
			assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
		for (let read = 0; read < 3; read++) assert.equal(service.sync("owner", null).task?.status, "paused");
		const after = service.sync("owner", snapshot("r2", "Thursday instead?")).task!;
		assert.equal(after.status, "paused");
		assert.match(after.detail!, /may have completed/);
		assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), false);
		assert.equal(agent.calls.length, 1);
	}
});

test("repeated unreadable views recover with a fresh decision and full countdown", async () => {
	for (const status of ["waiting", "thinking", "pending"] as const) {
		const { agent, service, advance } = setup();
		const initial = status === "waiting" ? snapshot("r1", "I'll check.", "outgoing") : snapshot();
		service.start("owner", "Arrange a meeting", initial);
		if (status === "pending") await resolveReply(agent);
		if (status === "waiting") {
			agent.calls[0]!.resolve({ action: "wait" });
			await Promise.resolve();
		}
		const original = service.sync("owner", initial).task!;
		assert.equal(original.status, status);
		const previousCalls = agent.calls.length;
		for (let read = 0; read < 3; read++) {
			advance(40_000);
			const paused = service.sync("owner", null);
			assert.equal(paused.task?.status, "paused");
			assert.equal(paused.task?.pendingReply, null);
			assert.equal(paused.command, null);
			assert.match(paused.task!.detail!, /resumes when it can read/);
		}
		const current = snapshot("r2", "Thursday instead?");
		const recovered = service.sync("owner", current);
		assert.equal(recovered.task?.status, "thinking");
		assert.equal(recovered.command, null);
		assert.equal(agent.calls.length, previousCalls + 1);
		assert.deepEqual(agent.calls.at(-1)!.snapshot, current);
		if (status === "thinking") {
			assert.equal(agent.calls[0]!.signal?.aborted, true);
			await resolveReply(agent, 0, "Stale reply.");
			assert.equal(service.sync("owner", current).task?.pendingReply, null);
		}
		await resolveReply(agent, previousCalls, "Thursday works.");
		const pending = service.sync("owner", current).task!.pendingReply!;
		assert.notEqual(pending.commandId, original.pendingReply?.commandId);
		advance(9_999);
		assert.equal(service.sync("owner", current).command, null);
		advance(1);
		assert.deepEqual(service.sync("owner", current).command, {
			commandId: pending.commandId,
			chatId: current.chatId,
			expectedRevision: "r2",
			text: "Thursday works.",
		});
	}
});

test("user controls, changed chats and connection loss cancel automatic recovery", () => {
	for (const interruption of ["pause", "update-goal", "take-over", "changed-chat", "disconnect", "timeout"] as const) {
		const { agent, service, advance } = setup();
		const task = service.start("owner", "Arrange a meeting", snapshot());
		service.sync("owner", null);
		if (interruption === "changed-chat") service.sync("owner", { ...snapshot(), chatId: "different-chat" });
		else if (interruption === "disconnect") service.disconnect("owner");
		else if (interruption === "timeout") advance(100_001);
		else
			service.control("owner", task.id, interruption, interruption === "update-goal" ? "Arrange Thursday" : undefined);
		service.sync("owner", null);
		const result = service.sync("owner", snapshot("r2", "Thursday instead?"));
		assert.equal(result.task?.status, interruption === "take-over" ? "taken_over" : "paused", interruption);
		assert.equal(result.task?.pendingReply, null);
		assert.equal(result.command, null);
		assert.equal(agent.calls.length, 1, interruption);
	}
});

test("reconnecting after an unreadable view still requires an explicit resume", () => {
	for (const connectorId of ["owner", "replacement"]) {
		const { agent, service, advance } = setup();
		const task = service.start("owner", "Arrange a meeting", snapshot());
		service.sync("owner", null);
		assert.throws(() => service.attach(connectorId, task.id, snapshot()));
		advance(100_001);
		assert.equal(service.attach(connectorId, task.id, snapshot()).status, "paused");
		const current = snapshot("r2", "Thursday instead?");
		assert.equal(service.sync(connectorId, current).task?.status, "paused");
		assert.equal(agent.calls.length, 1);
		assert.equal(service.control(connectorId, task.id, "resume").status, "thinking");
		assert.equal(agent.calls.length, 2);
	}
});

test("unreadable views do not automatically resume editing or requests for user input", async () => {
	for (const status of ["editing", "saved-edit", "needs_user"] as const) {
		const { agent, service } = setup();
		const task = service.start("owner", "Arrange a meeting", snapshot());
		if (status !== "needs_user") {
			await resolveReply(agent);
			service.control("owner", task.id, "edit");
			if (status === "saved-edit") service.control("owner", task.id, "save-edit", "I will check Thursday.");
		} else {
			agent.calls[0]!.resolve({ action: "ask", text: "Which day?" });
			await Promise.resolve();
		}
		assert.equal(service.sync("owner", snapshot()).task?.status, status === "saved-edit" ? "pending" : status);
		for (let read = 0; read < 3; read++) service.sync("owner", null);
		const result = service.sync("owner", snapshot("r2", "Thursday instead?"));
		assert.equal(result.task?.status, "paused");
		assert.equal(result.command, null);
		assert.equal(agent.calls.length, 1);
	}
});

for (const status of ["taken_over", "completed"] as const) {
	test(`${status} tasks ignore late conversation updates without renewing the lease`, async () => {
		let time = 1000;
		const agent = new ControlledAgent();
		const connector = new ExtensionConnector();
		const service = new TaskService(agent, { now: () => time, connector: () => connector });
		const initial = snapshot();
		const task = service.start("owner", "Arrange a meeting", initial);
		agent.calls[0]!.resolve(status === "completed" ? { action: "finish", text: "Done" } : { action: "wait" });
		await Promise.resolve();
		const terminal =
			status === "taken_over" ? service.control("owner", task.id, "take-over") : service.sync("owner", initial).task!;
		assert.equal(terminal.status, status);
		time += 4000;
		for (const update of [
			snapshot("r2", "Later private message"),
			snapshot("r1", "Changed content"),
			{ ...snapshot(), chatId: "other-chat" },
			null,
		]) {
			assert.deepEqual(service.sync("owner", update), { task: terminal, isOwner: true, command: null });
			assert.deepEqual(connector.readConversation(), initial);
		}
		assert.equal(agent.calls.length, 1);
		// The original eight-second lease still expires despite terminal polls.
		time += 4001;
		service.sync("other", null);
		assert.equal(connector.readConversation(), null);
		assert.equal(service.sync("owner", snapshot("r3", "Another later message")).task?.status, status);
		assert.equal(connector.readConversation(), null);
		service.clear("owner", task.id);
		assert.equal(service.sync("owner", null).task, null);
		assert.notEqual(service.start("owner", "A new goal", snapshot("r4")).id, task.id);
	});
}

for (const empty of [false, true]) {
	test(`task start can initiate in ${empty ? "an empty chat" : "a chat with an outgoing last message"}`, async () => {
		const { agent, service, advance } = setup();
		const current = snapshot("r1", "Thanks for yesterday!", "outgoing");
		if (empty) current.messages = [];
		service.start("owner", "Ask whether Thursday works for dinner", current);
		assert.equal(agent.calls.length, 1);
		assert.equal(agent.calls[0]!.reason, "task_started");
		service.sync("owner", current);
		assert.equal(agent.calls.length, 1);
		await resolveReply(agent, 0, "Would Thursday evening work for dinner?");
		assert.equal(service.sync("owner", current).task?.pendingReply?.sendAt, 11_000);
		advance(9_999);
		assert.equal(service.sync("owner", current).command, null);
		advance(1);
		const command = service.sync("owner", current).command!;
		assert.ok(command);
		assert.equal(service.sync("owner", current).command, null);
		assert.equal(service.authorize("owner", command.commandId, "wrong-chat", current.revision), false);
		assert.equal(service.authorize("owner", command.commandId, current.chatId, current.revision), true);
		assert.equal(service.authorize("owner", command.commandId, current.chatId, current.revision), false);
		service.report("owner", command.commandId, "sent");
		assert.equal(service.sync("owner", current).command, null);
		assert.equal(agent.calls.length, 1);
	});
}

test("a wait stays idle until instructions change, resume, or a new incoming message", async () => {
	const { agent, service } = setup();
	const current = snapshot("r1", "Would Thursday evening work for dinner?", "outgoing");
	const task = service.start("owner", "Ask whether Thursday works for dinner", current);
	agent.calls[0]!.resolve({ action: "wait" });
	await Promise.resolve();
	for (let i = 0; i < 3; i++) assert.equal(service.sync("owner", current).task?.status, "waiting");
	assert.equal(agent.calls.length, 1);
	service.control("owner", task.id, "update-goal", "Ask about Friday instead");
	assert.equal(agent.calls[1]!.reason, "instructions_updated");
	agent.calls[1]!.resolve({ action: "wait" });
	await Promise.resolve();
	service.control("owner", task.id, "pause");
	service.control("owner", task.id, "update-goal", "Ask about Saturday instead");
	assert.equal(service.sync("owner", current).task?.status, "paused");
	assert.equal(agent.calls.length, 2);
	service.control("owner", task.id, "resume");
	assert.equal(agent.calls[2]!.reason, "user_resumed");
	agent.calls[2]!.resolve({ action: "wait" });
	await Promise.resolve();
	service.sync("owner", current);
	assert.equal(agent.calls.length, 3);
	service.sync("owner", snapshot("r2", "Saturday works"));
	assert.equal(agent.calls[3]!.reason, "new_message");
});

test("cancelling an initiated reply suppresses regeneration, including after resume", async () => {
	const { agent, service } = setup();
	const current = snapshot("r1", "Thanks!", "outgoing");
	const task = service.start("owner", "Ask about dinner", current);
	await resolveReply(agent);
	service.control("owner", task.id, "cancel");
	service.control("owner", task.id, "pause");
	service.control("owner", task.id, "resume");
	assert.equal(service.sync("owner", current).task?.pendingReply, null);
	assert.equal(agent.calls.length, 1);
	const cosmetic = { ...current, revision: "cosmetic" };
	service.sync("owner", cosmetic);
	assert.equal(agent.calls.length, 1);
});

test("new messages invalidate an initiated reply and pause aborts its replacement", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Ask about dinner", snapshot("r1", "Thanks!", "outgoing"));
	await resolveReply(agent);
	const incoming = snapshot("r2", "How about dinner?");
	assert.equal(service.sync("owner", incoming).task?.pendingReply, null);
	assert.equal(agent.calls[1]!.reason, "new_message");
	service.control("owner", task.id, "pause");
	assert.equal(agent.calls[1]!.signal?.aborted, true);
	await resolveReply(agent, 1);
	advance(10_000);
	assert.equal(service.sync("owner", incoming).task?.status, "paused");
	assert.equal(service.sync("owner", incoming).command, null);
});

test("an initiated reply recovers from a temporary unreadable view with its evaluation reason", async () => {
	const { agent, service } = setup();
	const current = snapshot("r1", "Thanks!", "outgoing");
	service.start("owner", "Ask about dinner", current);
	await resolveReply(agent);
	service.sync("owner", null);
	assert.equal(service.sync("owner", current).task?.status, "thinking");
	assert.equal(agent.calls[1]!.reason, "task_started");
});

test("instruction updates leave an uncertain paused send paused", async () => {
	const { agent, service, advance } = setup();
	const current = snapshot("r1", "Thanks!", "outgoing");
	const task = service.start("owner", "Ask about dinner", current);
	await resolveReply(agent);
	advance(10_000);
	const command = service.sync("owner", current).command!;
	assert.equal(service.authorize("owner", command.commandId, current.chatId, current.revision), true);
	service.control("owner", task.id, "pause");
	const updated = service.control("owner", task.id, "update-goal", "Ask about lunch instead");
	assert.equal(updated.status, "paused");
	assert.match(updated.detail!, /may have completed/);
	assert.equal(agent.calls.length, 1);
});

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
	await resolveReply(agent, 1, "After 3.");
	assert.equal(service.control("owner", task.id, "cancel").agentChat.at(-1)?.text, "Reply cancelled.");
	service.sync("owner", snapshot("r3", "Friday instead?"));
	assert.ok(agent.calls[2]!.task.agentChat.some((entry) => entry.text === "Reply sent."));
	assert.ok(agent.calls[2]!.task.agentChat.some((entry) => entry.text === "Reply cancelled."));
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

test("a sender display rename at the same revision does not pause verification", () => {
	const { service } = setup();
	const named = (sender: string | null) => {
		const renamed = snapshot();
		renamed.messages[0] = { ...renamed.messages[0]!, sender };
		return renamed;
	};
	service.start("owner", "Arrange a meeting", named("Mikołaj Gaweł"));
	const { task } = service.sync("owner", named("Mikołaj"));
	assert.notEqual(task?.status, "paused");
	assert.doesNotMatch(task?.detail ?? "", /could not be verified/);
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
