import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";
import { appRouter } from "./router.js";
import { config } from "./config.js";

const server = new WebSocketServer({ host: config.host, port: config.port });
applyWSSHandler({ wss: server, router: appRouter });

server.on("listening", () => {
	console.info(
		`Envoy backend listening on host ${config.host}, port ${config.port}`,
	);
});
server.on("error", () => {
	console.error(
		`Envoy backend could not start. Check host ${config.host} and port ${config.port}.`,
	);
	process.exitCode = 1;
});

function shutdown(): void {
	for (const client of server.clients) client.terminate();
	server.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
