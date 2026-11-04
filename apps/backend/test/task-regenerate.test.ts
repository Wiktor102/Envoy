import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveReply, setup, snapshot } from "./support/task-fixtures.js";

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

test("regenerate from pending discards the proposal and drafts a fresh one", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	assert.equal(service.sync("owner", snapshot()).task?.status, "pending");
	const state = service.control("owner", task.id, "regenerate");
	assert.equal(state.status, "thinking");
	assert.equal(agent.calls.length, 2);
	assert.equal(agent.calls[1]!.reason, "regenerate_requested");
	await resolveReply(agent, 1, "Wednesday works.");
	assert.equal(service.sync("owner", snapshot()).task?.pendingReply?.text, "Wednesday works.");
});

test("regenerate after cancel drafts a fresh proposal without a new message", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	assert.equal(service.control("owner", task.id, "cancel").status, "waiting");
	service.sync("owner", snapshot());
	assert.equal(agent.calls.length, 1);
	const state = service.control("owner", task.id, "regenerate");
	assert.equal(state.status, "thinking");
	assert.equal(agent.calls.length, 2);
	assert.equal(agent.calls[1]!.reason, "regenerate_requested");
	await resolveReply(agent, 1);
	assert.equal(service.sync("owner", snapshot()).task?.pendingReply?.text, "Tuesday works.");
});

test("regenerate throws when there is nothing safe to regenerate", async () => {
	const first = setup();
	const task = first.service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(first.agent);
	first.advance(10_000);
	const claim = first.service.sync("owner", snapshot()).command!;
	assert.ok(claim);
	first.service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision);
	assert.throws(() => first.service.control("owner", task.id, "regenerate"), /no reply to regenerate/);
	const second = setup();
	const idle = second.service.start("owner", "Arrange a meeting", snapshot());
	second.agent.calls[0]!.resolve({ action: "wait" });
	await Promise.resolve();
	assert.equal(second.service.sync("owner", snapshot()).task?.status, "waiting");
	assert.throws(() => second.service.control("owner", idle.id, "regenerate"), /no reply to regenerate/);
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

test("answering after cancel triggers one fresh evaluation without a new message", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	assert.equal(service.control("owner", task.id, "cancel").status, "waiting");
	service.sync("owner", snapshot());
	assert.equal(agent.calls.length, 1);
	const answered = service.control("owner", task.id, "answer-agent", "Ask about sport instead.");
	assert.equal(answered.status, "thinking");
	assert.equal(agent.calls.length, 2);
	assert.equal(agent.calls[1]!.reason, "instructions_updated");
	agent.calls[1]!.resolve({ action: "wait" });
	await Promise.resolve();
	assert.equal(service.sync("owner", snapshot()).task?.status, "waiting");
	assert.equal(agent.calls.length, 2);
});

test("updating instructions after cancel triggers one fresh evaluation without a new message", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	assert.equal(service.control("owner", task.id, "cancel").status, "waiting");
	service.sync("owner", snapshot());
	assert.equal(agent.calls.length, 1);
	const updated = service.control("owner", task.id, "update-goal", "Ask about lunch instead.");
	assert.equal(updated.status, "thinking");
	assert.equal(agent.calls.length, 2);
	assert.equal(agent.calls[1]!.reason, "instructions_updated");
	agent.calls[1]!.resolve({ action: "wait" });
	await Promise.resolve();
	assert.equal(service.sync("owner", snapshot()).task?.status, "waiting");
	assert.equal(agent.calls.length, 2);
});
