import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtensionConnector } from "../src/connectors/extension-connector.js";
import { TaskService } from "../src/tasks/service.js";
import { ControlledAgent, resolveReply, setup, snapshot } from "./support/task-fixtures.js";

test("a transient unreadable view resumes the agent once the same chat reads again", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	await resolveReply(agent);
	const paused = service.sync("owner", null).task!;
	assert.equal(paused.status, "paused");
	assert.equal(paused.pendingReply, null);
	assert.deepEqual(paused.detail!, { code: "conversation_unavailable_resumable" });
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
		assert.deepEqual(after.detail!, { code: "conversation_unavailable_send_uncertain" });
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
			assert.deepEqual(paused.task!.detail!, { code: "conversation_unavailable_resumable" });
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
	assert.deepEqual(updated.detail!, { code: "send_may_have_completed_before_resuming" });
	assert.equal(agent.calls.length, 1);
});
