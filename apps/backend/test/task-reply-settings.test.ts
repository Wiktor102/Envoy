import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskService } from "../src/tasks/service.js";
import { ControlledAgent, resolveReply, setup, snapshot } from "./support/task-fixtures.js";

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
	assert.deepEqual(task?.detail, { code: "auto_send_off" });
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
