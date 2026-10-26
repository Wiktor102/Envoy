import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { WebSocketServer } from 'ws';
import { appRouter } from './router.js';

// Local development only. Add deployment configuration and authentication later.
const server = new WebSocketServer({ host: '127.0.0.1', port: 3001 });
applyWSSHandler({ wss: server, router: appRouter });

server.on('listening', () => {
  console.info('Envoy backend listening on ws://127.0.0.1:3001');
});
server.on('error', () => {
  console.error('Envoy backend could not start. Check that port 3001 is free.');
  process.exitCode = 1;
});

function shutdown(): void {
  for (const client of server.clients) client.terminate();
  server.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
