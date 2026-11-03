const host = process.env.HOST ?? "127.0.0.1";
const portValue = process.env.PORT ?? "3001";
const port = Number(portValue);

if (!host.trim()) {
	throw new Error("HOST must not be empty.");
}
// The digit-only check already guarantees a non-negative integer string, so
// only the range still needs testing.
if (!/^\d+$/.test(portValue) || port < 1 || port > 65535) {
	throw new Error("PORT must be an integer between 1 and 65535.");
}

export const config = { host, port };

// Connect locally when the server listens on all interfaces.
const loopbackFor: Record<string, string> = { "0.0.0.0": "127.0.0.1", "::": "::1" };
const clientHost = loopbackFor[host] ?? host;
const urlHost = clientHost.includes(":") ? `[${clientHost}]` : clientHost;
export const backendUrl = `ws://${urlHost}:${port}`;
