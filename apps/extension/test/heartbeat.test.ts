import assert from "node:assert/strict";
import { test } from "node:test";
import { OWNER_HEARTBEAT_PORT, startBackgroundHeartbeat, startOwnerHeartbeat } from "../src/heartbeat";

class FakeEvent {
	listeners = new Set<(...args: any[]) => void>();
	addListener(listener: (...args: any[]) => void) {
		this.listeners.add(listener);
	}
	removeListener(listener: (...args: any[]) => void) {
		this.listeners.delete(listener);
	}
	emit(...args: any[]) {
		for (const listener of [...this.listeners]) listener(...args);
	}
}

function fakePort() {
	const onMessage = new FakeEvent();
	const onDisconnect = new FakeEvent();
	const sent: unknown[] = [];
	return {
		onMessage,
		onDisconnect,
		sent,
		postMessage(message: unknown) {
			sent.push(message);
		},
		disconnect() {
			onDisconnect.emit();
		},
	};
}

test("background heartbeats stop when the owner port disconnects", () => {
	const port = fakePort();
	let pulse: (() => void) | null = null;
	let cleared = false;
	const clock = {
		setInterval(callback: () => void, delay: number) {
			assert.equal(delay, 2000);
			pulse = callback;
			return 1;
		},
		clearInterval(id: number) {
			assert.equal(id, 1);
			cleared = true;
		},
	};
	startBackgroundHeartbeat(port as unknown as chrome.runtime.Port, clock as unknown as typeof globalThis);
	assert.deepEqual(port.sent, [{ type: "envoy:heartbeat-tick" }]);
	assert.ok(pulse);
	(pulse as () => void)();
	assert.equal(port.sent.length, 2);
	port.onDisconnect.emit();
	assert.equal(cleared, true);
	(pulse as () => void)();
	assert.equal(port.sent.length, 2);
});

test("the owner responds to worker ticks and ignores unrelated messages", () => {
	const port = fakePort();
	const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: {
			runtime: {
				connect(options: { name: string }) {
					assert.equal(options.name, OWNER_HEARTBEAT_PORT);
					return port;
				},
			},
		},
	});
	let ticks = 0;
	let disconnected = 0;
	try {
		const stop = startOwnerHeartbeat(
			() => ticks++,
			() => disconnected++,
		);
		port.onMessage.emit({ type: "unrelated" });
		assert.equal(ticks, 0);
		port.onMessage.emit({ type: "envoy:heartbeat-tick" });
		assert.equal(ticks, 1);
		assert.deepEqual(port.sent, [{ type: "envoy:heartbeat-ack" }]);
		stop();
		assert.equal(disconnected, 0);
		port.onMessage.emit({ type: "envoy:heartbeat-tick" });
		assert.equal(ticks, 1);
	} finally {
		if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
		else delete (globalThis as { chrome?: unknown }).chrome;
	}
});

test("a failed acknowledgement immediately reports a lost owner connection", () => {
	const port = fakePort();
	const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: { runtime: { connect: () => port } },
	});
	port.postMessage = () => {
		throw new Error("Port disconnected");
	};
	let disconnected = 0;
	try {
		const stop = startOwnerHeartbeat(
			() => {},
			() => disconnected++,
		);
		port.onMessage.emit({ type: "envoy:heartbeat-tick" });
		port.onDisconnect.emit();
		assert.equal(disconnected, 1);
		stop();
	} finally {
		if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
		else delete (globalThis as { chrome?: unknown }).chrome;
	}
});
