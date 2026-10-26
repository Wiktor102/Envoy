import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConnectorSyncResult, ConversationSnapshot, SendReplyCommand, TaskState } from "@envoy/contracts";
import { createEnvoyController } from "../src/controller";
import type { BackendRequest, callBackend } from "../src/messaging";
import type { MessengerChatAdapter } from "../src/messenger/chat-adapter";

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
	const adapter: MessengerChatAdapter = {
		async readConversation() {
			return observedSnapshot;
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
		observe(snapshot: ConversationSnapshot) {
			observedSnapshot = snapshot;
			update(snapshot, "Loaded.");
		},
	};
}

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

test("a transient loss of controls reaches the backend before a later heartbeat", { timeout: 5000 }, async (t) => {
	const firstHeartbeat = deferred<ConnectorSyncResult>();
	const firstHeartbeatRequested = deferred<void>();
	const unavailableResponse = deferred<ConnectorSyncResult>();
	const unavailableRequested = deferred<void>();
	const laterHeartbeatRequested = deferred<void>();
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
					firstHeartbeatRequested.resolve();
					return firstHeartbeat.promise;
				}
				if (!request.snapshot) {
					unavailableRequested.resolve();
					return unavailableResponse.promise;
				}
				if (request.snapshot.revision === "revision-2") laterHeartbeatRequested.resolve();
				return syncResult({ ...activeTask, status: "paused" });
			case "envoy:disconnect":
				return undefined;
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
	await unavailableRequested.promise;
	harness.observe({ ...initialSnapshot, revision: "revision-2" });
	await Promise.resolve();
	assert.equal(
		harness.calls.some((request) => request.type === "envoy:sync" && request.snapshot?.revision === "revision-2"),
		false,
	);
	unavailableResponse.resolve(syncResult({ ...activeTask, status: "paused" }));
	await laterHeartbeatRequested.promise;
	const snapshots = harness.calls
		.filter((request): request is Extract<BackendRequest, { type: "envoy:sync" }> => request.type === "envoy:sync")
		.map((request) => request.snapshot?.revision ?? null);
	assert.deepEqual(snapshots.slice(-3), ["revision-1", null, "revision-2"]);
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
