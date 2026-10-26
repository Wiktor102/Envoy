import { createTRPCClient, createWSClient, wsLink } from '@trpc/client';
import type { AppRouter } from './router.js';

const connection = createWSClient({ url: 'ws://127.0.0.1:3001' });
const client = createTRPCClient<AppRouter>({
  links: [wsLink({ client: connection })],
});

try {
  const health = await client.health.query(undefined, {
    signal: AbortSignal.timeout(5_000),
  });
  if (health.status !== 'ok' || health.service !== 'envoy-backend') {
    throw new Error('Unexpected health response');
  }
  console.info(JSON.stringify(health));
} catch {
  console.error('Envoy health check failed. Start the backend first.');
  process.exitCode = 1;
} finally {
  await connection.close();
}
