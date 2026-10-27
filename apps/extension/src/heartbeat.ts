// The background worker is not subject to hidden-tab timer throttling. The
// owner document still reads its own DOM before every heartbeat.
export const OWNER_HEARTBEAT_PORT = "envoy:owner-heartbeat";
const HEARTBEAT_INTERVAL_MS = 2_000;
const TICK = "envoy:heartbeat-tick";
const ACK = "envoy:heartbeat-ack";

type HeartbeatPort = Pick<chrome.runtime.Port, "postMessage" | "onMessage" | "onDisconnect">;
type HeartbeatClock = Pick<typeof globalThis, "setInterval" | "clearInterval">;

export function startBackgroundHeartbeat(port: HeartbeatPort, clock: HeartbeatClock = globalThis): () => void {
	let stopped = false;
	const sendTick = () => {
		if (stopped) return;
		try {
			port.postMessage({ type: TICK });
		} catch {
			stop();
		}
	};
	const timer = clock.setInterval(sendTick, HEARTBEAT_INTERVAL_MS);
	const onDisconnect = () => stop();
	// Incoming port messages keep an MV3 service worker active. They carry no
	// conversation content and do not refresh the backend lease themselves.
	const onMessage = (_message: unknown) => {};
	function stop() {
		if (stopped) return;
		stopped = true;
		clock.clearInterval(timer);
		port.onDisconnect.removeListener(onDisconnect);
		port.onMessage.removeListener(onMessage);
	}
	port.onDisconnect.addListener(onDisconnect);
	port.onMessage.addListener(onMessage);
	sendTick();
	return stop;
}

export type StartOwnerHeartbeat = (onTick: () => void, onDisconnect: () => void) => () => void;

export const startOwnerHeartbeat: StartOwnerHeartbeat = (onTick, onDisconnect) => {
	const port = chrome.runtime.connect({ name: OWNER_HEARTBEAT_PORT });
	let closed = false;
	function markDisconnected() {
		if (closed) return;
		closed = true;
		try {
			port.disconnect();
		} catch {
			// The worker may already have closed the port.
		}
		onDisconnect();
	}
	port.onMessage.addListener((message: unknown) => {
		if (closed || typeof message !== "object" || message === null || !("type" in message) || message.type !== TICK)
			return;
		onTick();
		try {
			port.postMessage({ type: ACK });
		} catch {
			// Treat a failed acknowledgement as a lost port even if Chrome does
			// not dispatch onDisconnect after postMessage throws.
			markDisconnected();
		}
	});
	port.onDisconnect.addListener(markDisconnected);
	return () => {
		if (closed) return;
		closed = true;
		port.disconnect();
	};
};
