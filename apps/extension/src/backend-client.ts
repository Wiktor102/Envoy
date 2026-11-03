import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { AppRouter } from "@envoy/backend/router";

// Only the background worker imports this module. No server runtime imports.
export function createBackendClient() {
	// Idle time before an unused socket closes.
	const CLOSE_MS = 1_000;
	const connection = createWSClient({
		url: "ws://127.0.0.1:3001",
		lazy: { enabled: true, closeMs: CLOSE_MS },
	});

	return createTRPCClient<AppRouter>({
		links: [wsLink({ client: connection })],
	});
}
