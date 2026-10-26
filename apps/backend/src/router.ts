import { initTRPC } from '@trpc/server';
import type { HealthResponse } from '@envoy/contracts';

const t = initTRPC.create();

export const appRouter = t.router({
  health: t.procedure.query((): HealthResponse => ({
    status: 'ok',
    service: 'envoy-backend',
  })),
  // TODO: Add task procedures and subscriptions when task behavior exists.
});

export type AppRouter = typeof appRouter;
