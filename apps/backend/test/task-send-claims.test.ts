import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveReply, setup, snapshot } from "./support/task-fixtures.js";

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
	assert.equal(service.report("owner", newClaim.commandId, "sent")?.status, "thinking");
	assert.equal(agent.calls[1]!.reason, "reply_sent");
	agent.calls[1]!.resolve({ action: "wait" });
	await Promise.resolve();
	assert.equal(service.sync("owner", snapshot()).task?.status, "waiting");
	assert.equal(service.report("owner", newClaim.commandId, "sent")?.status, "waiting");
	assert.equal(service.sync("owner", snapshot()).command, null);
	assert.equal(agent.calls.length, 2);
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
	assert.equal(service.report("owner", retry.commandId, "sent")?.status, "thinking");
	agent.calls[1]!.resolve({ action: "wait" });
	await Promise.resolve();
	assert.equal(service.sync("owner", snapshot()).task?.status, "waiting");
	assert.equal(agent.calls.length, 2);
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
	assert.deepEqual(state.detail, { code: "reply_not_sent_check_conversation" });
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
	assert.deepEqual(state.detail, { code: "previous_send_may_have_completed_before_resuming" });
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
		assert.deepEqual(takenOver.detail, { code: "taken_over_checking_previous_send" });
		assert.throws(() => service.start("owner", "Try again", snapshot()), /still being checked/);
		assert.throws(() => service.clear("owner", task.id), /still being checked/);
		const reported = service.report("owner", claim.commandId, result)!;
		assert.equal(reported.status, "taken_over");
		if (result === "rejected") {
			assert.equal(service.start("owner", "Try again", snapshot()).status, "thinking");
		} else {
			assert.deepEqual(reported.detail, { code: "previous_send_may_have_completed_before_new_task" });
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
	assert.deepEqual(expired.task?.detail, { code: "previous_send_may_have_completed_before_resuming" });
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
	assert.deepEqual(state.detail, { code: "previous_send_may_have_completed_before_new_task" });
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
	assert.deepEqual(state.detail, { code: "previous_send_may_have_completed_before_resuming" });
	assert.equal(agent.calls.length, 1);
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
	assert.deepEqual(result.detail, { code: "send_may_have_completed_before_editing" });
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
	const reported = service.report("owner", claim.commandId, "sent")!;
	assert.equal(reported.status, "thinking");
	assert.deepEqual(reported.detail, { code: "checking_if_task_complete" });
	assert.equal(agent.calls[1]!.reason, "reply_sent");
	assert.equal(agent.calls[1]!.snapshot.revision, "r2");
	agent.calls[1]!.resolve({ action: "wait" });
	await Promise.resolve();
	assert.equal(service.sync("owner", outgoing).task?.status, "waiting");
	assert.equal(agent.calls.length, 2);
	service.sync("owner", snapshot("r3", "What time?"));
	assert.equal(agent.calls.length, 3);
	assert.equal(agent.calls[2]!.reason, "new_message");
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
		const reported = service.report("owner", claim.commandId, result)!;
		if (result === "sent") {
			assert.equal(reported.status, "thinking");
			agent.calls[1]!.resolve({ action: "wait" });
			await Promise.resolve();
		}
		const restored = snapshot("original-with-reaction");
		restored.messages[0]!.reactions = [{ label: "one reaction", emojis: ["👍"], count: 1 }];
		service.sync("owner", restored);
		if (result !== "sent") service.control("owner", task.id, "resume");
		assert.equal(service.sync("owner", restored).task?.status, "waiting");
		assert.equal(agent.calls.length, result === "sent" ? 2 : 1);
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
	assert.deepEqual(attached.detail, { code: "reconnected_send_may_have_completed" });
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
	assert.deepEqual(result.task?.detail!, { code: "send_unconfirmed_check_conversation" });
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
