import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { type AppRouter, healthResponse } from "./router.js";
import { backendUrl } from "./config.js";

const connection = createWSClient({ url: backendUrl });
const client = createTRPCClient<AppRouter>({
	links: [wsLink({ client: connection })],
});

try {
	const health = await client.health.query(undefined, {
		signal: AbortSignal.timeout(5_000),
	});
	if (health.status !== healthResponse.status || health.service !== healthResponse.service) {
		throw new Error("Unexpected health response");
	}
	console.info(JSON.stringify(health));
} catch (error) {
	console.error("Envoy health check failed. Start the backend first.", error);
	process.exitCode = 1;
} finally {
	await connection.close();
}
