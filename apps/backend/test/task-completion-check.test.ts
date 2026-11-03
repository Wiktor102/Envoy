import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveReply, setup, snapshot } from "./support/task-fixtures.js";

test("a confirmed send runs one completion check that can finish the task", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Confirm Friday 18:00 for the board-game session", snapshot());
	await resolveReply(agent, 0, "Friday 18:00 works for us.");
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	const reported = service.report("owner", claim.commandId, "sent")!;
	assert.equal(reported.status, "thinking");
	assert.deepEqual(reported.detail, { code: "checking_if_task_complete" });
	assert.equal(agent.calls.length, 2);
	assert.equal(agent.calls[1]!.reason, "reply_sent");
	// The check sees the sent text even before the outgoing bubble arrives.
	assert.equal(agent.calls[1]!.task.agentChat.at(-1)?.text, "Reply sent.");
	assert.equal(agent.calls[1]!.task.agentChat.at(-1)?.body, "Friday 18:00 works for us.");
	agent.calls[1]!.resolve({ action: "finish", text: "Confirmed Friday 18:00." });
	await Promise.resolve();
	const completed = service.sync("owner", snapshot()).task!;
	assert.equal(completed.status, "completed");
	assert.deepEqual(completed.detail, { code: "agent_message", text: "Confirmed Friday 18:00." });
	// Late follow-ups to the ended task are ignored, never re-evaluated.
	service.sync("owner", snapshot("r2", "Actually, can we do 19:00?"));
	assert.equal(agent.calls.length, 2);
	assert.equal(service.sync("owner", snapshot("r2", "Actually, can we do 19:00?")).task?.status, "completed");
	assert.equal(task.chatId, "chat-1");
});

test("the post-send check waits when the goal needs an acknowledgment", async () => {
	const { agent, service, advance } = setup();
	service.start("owner", "Confirm the place and get their OK", snapshot());
	await resolveReply(agent, 0, "Shall we meet at the library?");
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	assert.equal(service.report("owner", claim.commandId, "sent")?.status, "thinking");
	agent.calls[1]!.resolve({ action: "wait" });
	await Promise.resolve();
	const waiting = service.sync("owner", snapshot()).task!;
	assert.equal(waiting.status, "waiting");
	assert.deepEqual(waiting.detail, { code: "reply_sent_waiting" });
	// The late outgoing bubble and repeat syncs never re-run the check.
	const outgoing = snapshot("r2", "Shall we meet at the library?", "outgoing");
	assert.equal(service.sync("owner", outgoing).task?.status, "waiting");
	assert.deepEqual(service.sync("owner", outgoing).task?.detail, { code: "waiting_for_incoming" });
	assert.equal(agent.calls.length, 2);
});

test("a reply decision after a confirmed send never produces a pending reply", async () => {
	const { agent, service, advance } = setup();
	service.start("owner", "Confirm Friday", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	assert.equal(service.report("owner", claim.commandId, "sent")?.status, "thinking");
	agent.calls[1]!.resolve({ action: "reply", text: "One more thing." });
	await Promise.resolve();
	const waiting = service.sync("owner", snapshot()).task!;
	assert.equal(waiting.status, "waiting");
	assert.equal(waiting.pendingReply, null);
	assert.deepEqual(waiting.detail, { code: "reply_sent_waiting" });
	advance(20_000);
	assert.equal(service.sync("owner", snapshot()).command, null);
	assert.equal(agent.calls.length, 2);
});

test("an ask decision after a confirmed send degrades to waiting", async () => {
	const { agent, service, advance } = setup();
	service.start("owner", "Confirm Friday", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	assert.equal(service.report("owner", claim.commandId, "sent")?.status, "thinking");
	agent.calls[1]!.resolve({ action: "ask", text: "Should I follow up?" });
	await Promise.resolve();
	const waiting = service.sync("owner", snapshot()).task!;
	assert.equal(waiting.status, "waiting");
	assert.deepEqual(waiting.detail, { code: "reply_sent_waiting" });
	assert.ok(!waiting.agentChat.some((entry) => entry.text === "Should I follow up?"));
	assert.equal(agent.calls.length, 2);
});

test("pausing during the post-send check invalidates it like any generation", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Confirm Friday", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	assert.equal(service.report("owner", claim.commandId, "sent")?.status, "thinking");
	assert.equal(service.control("owner", task.id, "pause").status, "paused");
	assert.equal(agent.calls[1]!.signal?.aborted, true);
	// The late decision lands after invalidation and is ignored.
	agent.calls[1]!.resolve({ action: "finish", text: "Confirmed Friday." });
	await Promise.resolve();
	assert.equal(service.sync("owner", snapshot()).task?.status, "paused");
	assert.equal(service.control("owner", task.id, "resume").status, "waiting");
	assert.equal(agent.calls.length, 2);
	service.sync("owner", snapshot("r2", "Friday works for us."));
	assert.equal(agent.calls.length, 3);
	assert.equal(agent.calls[2]!.reason, "new_message");
});

test("cancelling during the post-send check does not re-run it", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Confirm Friday", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	assert.equal(service.report("owner", claim.commandId, "sent")?.status, "thinking");
	assert.equal(service.control("owner", task.id, "cancel").status, "waiting");
	agent.calls[1]!.resolve({ action: "finish", text: "Confirmed Friday." });
	await Promise.resolve();
	const state = service.sync("owner", snapshot()).task!;
	assert.equal(state.status, "waiting");
	assert.equal(agent.calls.length, 2);
});

test("taking over during the post-send check ends the task", async () => {
	const { agent, service, advance } = setup();
	const task = service.start("owner", "Confirm Friday", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	assert.equal(service.report("owner", claim.commandId, "sent")?.status, "thinking");
	assert.equal(service.control("owner", task.id, "take-over").status, "taken_over");
	agent.calls[1]!.resolve({ action: "finish", text: "Confirmed Friday." });
	await Promise.resolve();
	assert.equal(service.sync("owner", snapshot()).task?.status, "taken_over");
	assert.equal(agent.calls.length, 2);
});

test("a failed post-send check degrades to waiting instead of blocking", async () => {
	const { agent, service, advance } = setup();
	service.start("owner", "Confirm Friday", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	assert.equal(service.report("owner", claim.commandId, "sent")?.status, "thinking");
	agent.calls[1]!.reject(new Error("model unavailable"));
	await Promise.resolve();
	const waiting = service.sync("owner", snapshot()).task!;
	assert.equal(waiting.status, "waiting");
	assert.deepEqual(waiting.detail, { code: "reply_sent_waiting" });
	assert.equal(agent.calls.length, 2);
	// A later incoming message still triggers a normal evaluation.
	service.sync("owner", snapshot("r2", "Sounds good, see you then."));
	assert.equal(agent.calls.length, 3);
	assert.equal(agent.calls[2]!.reason, "new_message");
});

test("an incoming message racing the send report keeps a full evaluation", async () => {
	const { agent, service, advance } = setup();
	service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	// An incoming message lands while sending; the report must not downgrade it to a finish/wait-only check.
	assert.equal(service.sync("owner", snapshot("r2", "Actually, Friday?")).task?.status, "sending");
	assert.equal(service.report("owner", claim.commandId, "sent")?.status, "thinking");
	assert.equal(agent.calls[1]!.reason, "new_message");
	await resolveReply(agent, 1, "Friday works too.");
	assert.equal(service.sync("owner", snapshot("r2", "Actually, Friday?")).task?.pendingReply?.text, "Friday works too.");
});

test("the outgoing bubble landing mid-check re-runs the check once on the new snapshot", async () => {
	const { agent, service, advance } = setup();
	service.start("owner", "Confirm Friday", snapshot());
	await resolveReply(agent, 0, "Friday works for us.");
	advance(10_000);
	const claim = service.sync("owner", snapshot()).command!;
	assert.equal(service.authorize("owner", claim.commandId, claim.chatId, claim.expectedRevision), true);
	assert.equal(service.report("owner", claim.commandId, "sent")?.status, "thinking");
	assert.equal(agent.calls[1]!.snapshot.revision, "r1");
	const outgoing = snapshot("r2", "Friday works for us.", "outgoing");
	assert.equal(service.sync("owner", outgoing).task?.status, "thinking");
	assert.equal(agent.calls[1]!.signal?.aborted, true);
	assert.equal(agent.calls.length, 3);
	assert.equal(agent.calls[2]!.reason, "reply_sent");
	assert.equal(agent.calls[2]!.snapshot.revision, "r2");
	agent.calls[2]!.resolve({ action: "wait" });
	await Promise.resolve();
	assert.equal(service.sync("owner", outgoing).task?.status, "waiting");
	assert.equal(agent.calls.length, 3);
});
