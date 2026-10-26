import { createTRPCClient, createWSClient, wsLink } from '@trpc/client';
import type { AppRouter } from '@envoy/backend/router';

// Only the background worker imports this module. No server runtime imports.
export function createBackendClient() {
  const connection = createWSClient({
    url: 'ws://127.0.0.1:3001',
    lazy: { enabled: true, closeMs: 1_000 },
  });

  return createTRPCClient<AppRouter>({
    links: [wsLink({ client: connection })],
  });
}
