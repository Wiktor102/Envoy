import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConnectorSyncResult, ConversationSnapshot, SendReplyCommand, TaskState } from "@envoy/contracts";
import { createEnvoyController } from "../src/controller";
import type { BackendRequest, callBackend } from "../src/messaging";
import type { MessengerChatAdapter } from "../src/messenger/chat-adapter";
import { TaskService } from "../../backend/src/tasks/service.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const initialSnapshot: ConversationSnapshot = {
	chatId: "chat-1",
	revision: "revision-1",
	messages: [{ id: "message-1", text: "Hello", direction: "incoming", replyTo: null, attachments: [], reactions: [] }],
};

const activeTask: TaskState = {
	id: "task-1",
	chatId: initialSnapshot.chatId,
	goal: "Arrange a meeting",
	status: "waiting",
	pendingReply: null,
	detail: null,
};

function syncResult(task: TaskState | null, command: SendReplyCommand | null = null): ConnectorSyncResult {
	return { task, isOwner: Boolean(task), command };
}

function setup(handler: (request: BackendRequest) => unknown | Promise<unknown>) {
	const lifecycle = new EventTarget();
	const calls: BackendRequest[] = [];
	let observedSnapshot = initialSnapshot;
	let update!: (snapshot: ConversationSnapshot | null, status: string) => void;
	let sent = 0;
	let attempted = 0;
	let heartbeatTick: (() => void) | null = null;
	let heartbeatDisconnected: (() => void) | null = null;
	let heartbeatStarts = 0;
	let heartbeatStops = 0;
	let read: () => Promise<ConversationSnapshot | null> = async () => observedSnapshot;
	const adapter: MessengerChatAdapter = {
		async readConversation() {
			return read();
		},
		async sendReply(_command, authorize, isCurrent) {
			attempted++;
			if (!(await authorize()) || (isCurrent && !isCurrent())) return "rejected";
			sent++;
			return "sent";
		},
	};
	const transport = (async (request: BackendRequest) => {
		calls.push(request);
		return handler(request);
	}) as typeof callBackend;
	const controller = createEnvoyController({
		transport,
		adapter,
		lifecycle,
		heartbeat(onTick, onDisconnect) {
			heartbeatStarts++;
			heartbeatTick = onTick;
			heartbeatDisconnected = onDisconnect;
			return () => {
				heartbeatStops++;
				heartbeatTick = null;
				heartbeatDisconnected = null;
			};
		},
		watch(onUpdate) {
			update = onUpdate;
			onUpdate(observedSnapshot, "Loaded.");
			return () => {};
		},
	});
	controller.setControlsAvailable(true);
	return {
		controller,
		lifecycle,
		calls,
		get sent() {
			return sent;
		},
		get attempted() {
			return attempted;
		},
		get heartbeatStarts() {
			return heartbeatStarts;
		},
		get heartbeatStops() {
			return heartbeatStops;
		},
		tick() {
			assert.ok(heartbeatTick, "The owner heartbeat is not connected");
			heartbeatTick();
		},
		disconnectHeartbeat() {
			assert.ok(heartbeatDisconnected, "The owner heartbeat is not connected");
			const disconnected = heartbeatDisconnected;
			heartbeatTick = null;
			heartbeatDisconnected = null;
			disconnected();
		},
		setRead(next: () => Promise<ConversationSnapshot | null>) {
			read = next;
		},
		setSnapshot(snapshot: ConversationSnapshot) {
			observedSnapshot = snapshot;
		},
		observe(snapshot: ConversationSnapshot) {
			observedSnapshot = snapshot;
			update(snapshot, "Loaded.");
		},
	};
}

function setupWithService() {
	let time = 1_000;
	let agentCalls = 0;
	let task: TaskState | null = null;
	const service = new TaskService(
		{
			async run() {
				agentCalls++;
				return { action: "reply", text: "Tuesday works." };
			},
		},
		{ now: () => time, leaseMs: 100_000 },
	);
	const harness = setup((request) => {
		switch (request.type) {
			case "envoy:start":
				return service.start("owner", request.goal, request.snapshot);
			case "envoy:sync":
				return service.sync("owner", request.snapshot);
			case "envoy:control":
				return service.control("owner", request.taskId, request.action, request.text);
			case "envoy:authorize":
				return service.authorize("owner", request.commandId, request.chatId, request.revision);
			case "envoy:report":
				return service.report("owner", request.commandId, request.result);
			case "envoy:disconnect":
				return service.disconnect("owner");
			default:
				throw new Error(`Unexpected request: ${request.type}`);
		}
	});
	harness.controller.subscribe((state) => {
		task = state.task;
	});
	return {
		harness,
		advance(amount: number) {
			time += amount;
		},
		get agentCalls() {
			return agentCalls;
		},
		get task() {
			return task;
		},
	};
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const loss of ["controls", "heartbeat"] as const) {
	test(`${loss} loss requires explicit resume even when the conversation becomes readable`, async (t) => {
		for (const unreadableBeforeLoss of [false, true]) {
			const fixture = setupWithService();
			const { harness, advance } = fixture;
			t.after(() => harness.controller.destroy());
			await harness.controller.start(activeTask.goal);
			await flush();
			assert.equal(fixture.task?.status, "pending");
			if (unreadableBeforeLoss) {
				harness.setRead(async () => null);
				harness.tick();
				await flush();
				assert.equal(fixture.task?.status, "paused");
			}
			if (loss === "controls") {
				harness.controller.setControlsAvailable(false);
				harness.controller.setControlsAvailable(true);
			} else harness.disconnectHeartbeat();
			await flush();
			harness.setRead(async () => initialSnapshot);
			harness.tick();
			await flush();
			assert.equal(fixture.task?.status, "paused");
			advance(10_000);
			harness.tick();
			await flush();
			assert.equal(fixture.agentCalls, 1);
			assert.equal(harness.attempted, 0);
			assert.equal(harness.sent, 0);
			await harness.controller.control("resume");
			await flush();
			assert.equal(fixture.task?.status, "pending");
			assert.equal(fixture.agentCalls, 2);
			advance(9_999);
			harness.tick();
			await flush();
			assert.equal(harness.sent, 0);
			advance(1);
			harness.tick();
			await flush();
			assert.equal(harness.sent, 1);
		}
	});
}

test("temporary read failures still recover automatically with a full countdown", async (t) => {
	const fixture = setupWithService();
	const { harness, advance } = fixture;
	t.after(() => harness.controller.destroy());
	await harness.controller.start(activeTask.goal);
	await flush();
	harness.setRead(async () => null);
	for (let read = 0; read < 3; read++) {
		harness.tick();
		await flush();
		assert.equal(fixture.task?.status, "paused");
	}
	harness.setRead(async () => initialSnapshot);
	harness.tick();
	await flush();
	assert.equal(fixture.task?.status, "pending");
	assert.equal(fixture.agentCalls, 2);
	assert.equal(
		harness.calls.some((request) => request.type === "envoy:disconnect"),
		false,
	);
	advance(9_999);
	harness.tick();
	await flush();
	assert.equal(harness.sent, 0);
	advance(1);
	harness.tick();
	await flush();
	assert.equal(harness.sent, 1);
});

test("a locally invalidated claimed command is rejected without authorization or sending", { timeout: 5000 }, async (t) => {
	const heartbeat = deferred<ConnectorSyncResult>();
	const heartbeatRequested = deferred<void>();
	const reportReceived = deferred<BackendRequest>();
	let started = false;
	let heldHeartbeat = false;
	const harness = setup((request) => {
		switch (request.type) {
			case "envoy:start":
				started = true;
				return activeTask;
			case "envoy:sync":
				if (!started) return syncResult(null);
				if (!heldHeartbeat) {
					heldHeartbeat = true;
					heartbeatRequested.resolve();
					return heartbeat.promise;
				}
				return syncResult(activeTask);
			case "envoy:report":
				reportReceived.resolve(request);
				return activeTask;
			case "envoy:authorize":
				return true;
			case "envoy:disconnect":
				return undefined;
			default:
				throw new Error(`Unexpected request: ${request.type}`);
		}
	});
	t.after(() => harness.controller.destroy());
	await harness.controller.start(activeTask.goal);
	await heartbeatRequested.promise;
	harness.observe({ ...initialSnapshot, revision: "revision-2" });
	heartbeat.resolve(
		syncResult(
			{ ...activeTask, status: "sending" },
			{ commandId: "reply-1", chatId: initialSnapshot.chatId, expectedRevision: initialSnapshot.revision, text: "Hi" },
		),
	);
	const report = await reportReceived.promise;
	assert.deepEqual(report, { type: "envoy:report", commandId: "reply-1", result: "rejected" });
	assert.equal(
		harness.calls.some((request) => request.type === "envoy:authorize"),
		false,
	);
	assert.equal(harness.sent, 0);
	assert.equal(harness.attempted, 0);
});

test("control loss must confirm a disconnect before a later heartbeat", { timeout: 5000 }, async (t) => {
	const firstHeartbeat = deferred<ConnectorSyncResult>();
	const firstHeartbeatRequested = deferred<void>();
	const disconnectResponse = deferred<void>();
	const disconnectRequested = deferred<void>();
	const retryResponse = deferred<void>();
	const retryRequested = deferred<void>();
	const laterHeartbeatRequested = deferred<void>();
	let started = false;
	let heldHeartbeat = false;
	let disconnects = 0;
	const harness = setup((request) => {
		switch (request.type) {
			case "envoy:start":
				started = true;
				return activeTask;
			case "envoy:sync":
				if (!started) return syncResult(null);
				if (!heldHeartbeat) {
					heldHeartbeat = true;
					firstHeartbeatRequested.resolve();
					return firstHeartbeat.promise;
				}
				if (request.snapshot?.revision === "revision-2") laterHeartbeatRequested.resolve();
				return syncResult({ ...activeTask, status: "paused" });
			case "envoy:disconnect":
				if (++disconnects === 1) {
					disconnectRequested.resolve();
					return disconnectResponse.promise;
				}
				retryRequested.resolve();
				return retryResponse.promise;
			default:
				throw new Error(`Unexpected request: ${request.type}`);
		}
	});
	t.after(() => harness.controller.destroy());
	await harness.controller.start(activeTask.goal);
	await firstHeartbeatRequested.promise;
	harness.controller.setControlsAvailable(false);
	harness.controller.setControlsAvailable(true);
	firstHeartbeat.resolve(syncResult(activeTask));
	await disconnectRequested.promise;
	disconnectResponse.reject(new Error("Connection unavailable"));
	await flush();
	harness.observe({ ...initialSnapshot, revision: "revision-2" });
	await retryRequested.promise;
	assert.equal(
		harness.calls.some((request) => request.type === "envoy:sync" && request.snapshot?.revision === "revision-2"),
		false,
	);
	retryResponse.resolve();
	await laterHeartbeatRequested.promise;
	assert.deepEqual(
		harness.calls.slice(-4).map((request) => request.type),
		["envoy:sync", "envoy:disconnect", "envoy:disconnect", "envoy:sync"],
	);
});

test("pagehide waits for an in-flight start before disconnecting", { timeout: 5000 }, async (t) => {
	const startResponse = deferred<TaskState>();
	const startRequested = deferred<void>();
	const disconnectRequested = deferred<void>();
	const harness = setup((request) => {
		switch (request.type) {
			case "envoy:sync":
				return syncResult(null);
			case "envoy:start":
				startRequested.resolve();
				return startResponse.promise;
			case "envoy:disconnect":
				disconnectRequested.resolve();
				return undefined;
			default:
				throw new Error(`Unexpected request: ${request.type}`);
		}
	});
	t.after(() => harness.controller.destroy());
	const start = harness.controller.start(activeTask.goal);
	await startRequested.promise;
	harness.lifecycle.dispatchEvent(new Event("pagehide"));
	await Promise.resolve();
	assert.equal(
		harness.calls.some((request) => request.type === "envoy:disconnect"),
		false,
	);
	startResponse.resolve(activeTask);
	await start;
	await disconnectRequested.promise;
	const startIndex = harness.calls.findIndex((request) => request.type === "envoy:start");
	assert.deepEqual(
		harness.calls.slice(startIndex).map((request) => request.type),
		["envoy:start", "envoy:disconnect"],
	);
});

test("an older pageshow cannot resume a document hidden again before disconnect finishes", { timeout: 5000 }, async (t) => {
	const disconnectResponse = deferred<void>();
	const disconnectRequested = deferred<void>();
	const resumedHeartbeat = deferred<void>();
	let watchForResume = false;
	const harness = setup((request) => {
		switch (request.type) {
			case "envoy:sync":
				if (watchForResume) resumedHeartbeat.resolve();
				return syncResult(null);
			case "envoy:disconnect":
				disconnectRequested.resolve();
				return disconnectResponse.promise;
			default:
				throw new Error(`Unexpected request: ${request.type}`);
		}
	});
	t.after(() => harness.controller.destroy());
	await new Promise<void>((resolve) => setImmediate(resolve));
	const syncsBeforeHide = harness.calls.filter((request) => request.type === "envoy:sync").length;
	harness.lifecycle.dispatchEvent(new Event("pagehide"));
	await disconnectRequested.promise;
	harness.lifecycle.dispatchEvent(new Event("pageshow"));
	harness.lifecycle.dispatchEvent(new Event("pagehide"));
	disconnectResponse.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(harness.calls.filter((request) => request.type === "envoy:sync").length, syncsBeforeHide);
	await assert.rejects(harness.controller.start(activeTask.goal), /unavailable/);
	watchForResume = true;
	harness.lifecycle.dispatchEvent(new Event("pageshow"));
	await resumedHeartbeat.promise;
});

test("a background heartbeat reads the current conversation before syncing", { timeout: 5000 }, async (t) => {
	const newerSynced = deferred<void>();
	let started = false;
	const harness = setup((request) => {
		switch (request.type) {
			case "envoy:start":
				started = true;
				return activeTask;
			case "envoy:sync":
				if (request.snapshot?.revision === "revision-2") newerSynced.resolve();
				return syncResult(started ? activeTask : null);
			case "envoy:disconnect":
				return undefined;
			default:
				throw new Error(`Unexpected request: ${request.type}`);
		}
	});
	t.after(() => harness.controller.destroy());
	await harness.controller.start(activeTask.goal);
	assert.equal(harness.heartbeatStarts, 1);
	// The watcher did not fire. Only the worker's tick discovers this change.
	harness.setSnapshot({ ...initialSnapshot, revision: "revision-2" });
	harness.tick();
	await newerSynced.promise;
	assert.ok(harness.calls.some((request) => request.type === "envoy:sync" && request.snapshot?.revision === "revision-2"));
	assert.equal(harness.heartbeatStops, 0);
	harness.controller.setControlsAvailable(false);
	assert.equal(harness.heartbeatStops, 1);
});

test("a failed fresh read is reported even when a later read succeeds", { timeout: 5000 }, async (t) => {
	const firstHeartbeat = deferred<ConnectorSyncResult>();
	const heartbeatRequested = deferred<void>();
	const unavailableRequested = deferred<void>();
	let started = false;
	let held = false;
	const harness = setup((request) => {
		switch (request.type) {
			case "envoy:start":
				started = true;
				return activeTask;
			case "envoy:sync":
				if (!started) return syncResult(null);
				if (!held) {
					held = true;
					heartbeatRequested.resolve();
					return firstHeartbeat.promise;
				}
				if (!request.snapshot) unavailableRequested.resolve();
				return syncResult({ ...activeTask, status: "paused" });
			case "envoy:disconnect":
				return undefined;
			default:
				throw new Error(`Unexpected request: ${request.type}`);
		}
	});
	t.after(() => harness.controller.destroy());
	await harness.controller.start(activeTask.goal);
	await heartbeatRequested.promise;
	harness.setRead(async () => {
		throw new Error("unavailable");
	});
	harness.tick();
	await new Promise<void>((resolve) => setImmediate(resolve));
	// A successful watcher read may arrive before the held network response.
	harness.observe(initialSnapshot);
	firstHeartbeat.resolve(syncResult(activeTask));
	await unavailableRequested.promise;
	assert.ok(harness.calls.some((request) => request.type === "envoy:sync" && request.snapshot === null));
});

test("a stale heartbeat read cannot overwrite a newer watcher snapshot", { timeout: 5000 }, async (t) => {
	const readStarted = deferred<void>();
	const oldRead = deferred<ConversationSnapshot>();
	const freshSynced = deferred<void>();
	let started = false;
	const harness = setup((request) => {
		switch (request.type) {
			case "envoy:start":
				started = true;
				return activeTask;
			case "envoy:sync":
				if (request.snapshot?.revision === "revision-3") freshSynced.resolve();
				return syncResult(started ? activeTask : null);
			case "envoy:disconnect":
				return undefined;
			default:
				throw new Error(`Unexpected request: ${request.type}`);
		}
	});
	t.after(() => harness.controller.destroy());
	await harness.controller.start(activeTask.goal);
	harness.setRead(() => {
		readStarted.resolve();
		return oldRead.promise;
	});
	harness.tick();
	await readStarted.promise;
	const newest = { ...initialSnapshot, revision: "revision-3" };
	harness.observe(newest);
	harness.setRead(async () => newest);
	oldRead.resolve({ ...initialSnapshot, revision: "revision-2" });
	await freshSynced.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(
		harness.calls.some((request) => request.type === "envoy:sync" && request.snapshot?.revision === "revision-2"),
		false,
	);
});

test("a lost heartbeat port invalidates the owner and reports unavailable", { timeout: 5000 }, async (t) => {
	const unavailable = deferred<void>();
	let started = false;
	const harness = setup((request) => {
		switch (request.type) {
			case "envoy:start":
				started = true;
				return activeTask;
			case "envoy:sync":
				if (started && request.snapshot === null) unavailable.resolve();
				return syncResult(started ? { ...activeTask, status: "paused" } : null);
			case "envoy:disconnect":
				return undefined;
			default:
				throw new Error(`Unexpected request: ${request.type}`);
		}
	});
	t.after(() => harness.controller.destroy());
	await harness.controller.start(activeTask.goal);
	harness.disconnectHeartbeat();
	await unavailable.promise;
	assert.ok(harness.calls.some((request) => request.type === "envoy:sync" && request.snapshot === null));
});
