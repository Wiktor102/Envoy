import { defineBackground } from "wxt/utils/define-background";
import type { HealthReply } from "@envoy/contracts";
import { createBackendClient } from "../src/backend-client";

export default defineBackground(() => {
	const backend = createBackendClient();

	chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
		if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "envoy:health")
			return;

		// Chrome routes this response to the requesting content script/tab.
		void backend.health.query(undefined, { signal: AbortSignal.timeout(5_000) }).then(
			(health) => respond({ ok: true, health } satisfies HealthReply),
			() =>
				respond({
					ok: false,
					error: "backend-unavailable",
				} satisfies HealthReply),
		);
		return true;
	});
});
