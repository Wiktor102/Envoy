import type { HealthReply, HealthRequest } from "@envoy/contracts";

export function checkBackendHealth(): Promise<HealthReply> {
	return chrome.runtime.sendMessage<HealthRequest, HealthReply>({
		type: "envoy:health",
	});
}
