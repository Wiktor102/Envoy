import { initTRPC } from "@trpc/server";
import type { HealthResponse } from "@envoy/contracts";
import { MetaModelAdapter } from "./agent/meta-model.js";
import {
	attachInput,
	authorizeInput,
	clearInput,
	controlInput,
	disconnectInput,
	reportInput,
	startInput,
	syncInput,
} from "./router-input.js";
import { TaskService } from "./tasks/service.js";

const t = initTRPC.create();
const service = new TaskService(new MetaModelAdapter());

export const healthResponse: HealthResponse = { status: "ok", service: "envoy-backend" };

export const appRouter = t.router({
	health: t.procedure.query((): HealthResponse => healthResponse),
	task: t.router({
		start: t.procedure
			.input(startInput)
			.mutation(({ input }) =>
				service.start(input.connectorId, input.goal, input.snapshot, input.developerMode, input.replySettings),
			),
		attach: t.procedure
			.input(attachInput)
			.mutation(({ input }) => service.attach(input.connectorId, input.taskId, input.snapshot)),
		clear: t.procedure.input(clearInput).mutation(({ input }) => service.clear(input.connectorId, input.taskId)),
		control: t.procedure
			.input(controlInput)
			.mutation(({ input }) => service.control(input.connectorId, input.taskId, input.action, input.text)),
	}),
	connector: t.router({
		sync: t.procedure
			.input(syncInput)
			.mutation(({ input }) =>
				service.sync(input.connectorId, input.snapshot, input.developerMode, input.replySettings),
			),
		authorize: t.procedure
			.input(authorizeInput)
			.mutation(({ input }) => service.authorize(input.connectorId, input.commandId, input.chatId, input.revision)),
		report: t.procedure
			.input(reportInput)
			.mutation(({ input }) => service.report(input.connectorId, input.commandId, input.result)),
		disconnect: t.procedure.input(disconnectInput).mutation(({ input }) => service.disconnect(input.connectorId)),
	}),
});

export type AppRouter = typeof appRouter;
