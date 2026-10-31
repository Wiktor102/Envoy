import { defineBackground } from "wxt/utils/define-background";
import { normalizeReplySettings } from "@envoy/contracts";
import type { BackendRequest } from "../src/messaging";
import { createBackendClient } from "../src/backend-client";
import { OWNER_HEARTBEAT_PORT, startBackgroundHeartbeat } from "../src/heartbeat";
import { hasAcceptedTerms, TERMS_STORAGE_KEY } from "../src/terms";

// Only fixed service messages are forwarded. Provider/transport errors may
// contain private request content and must never be surfaced or logged.
const TERMS_REQUIRED = "Accept the Envoy Terms of Use first.";
const safeErrors = new Set([
	TERMS_REQUIRED,
	"A task is already active. Take over the existing task first.",
	"The previous send may have completed. Check the conversation and delete the old task first.",
	"A previous send is still being checked. Try again shortly.",
	"The agent tab is still connected or the task is not paused.",
	"Reconnect the agent tab to the original conversation first.",
	"The agent tab is disconnected.",
	"Take over the task before deleting it.",
	"Enter text between 1 and 4000 characters.",
	"Replies must be a single line without control characters.",
	"Task not found.",
	"Task or conversation not found.",
	"The task is not paused.",
	"This task has ended.",
	"There is no reply to edit.",
	"There is no reply being edited.",
	"There is no reply ready to send.",
	"There is no reply to cancel.",
]);

function connectorFor(sender: chrome.runtime.MessageSender): string | null {
	if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || !sender.documentId || !sender.url) return null;
	try {
		const url = new URL(sender.url);
		const messenger = /^(?:www\.)?messenger\.com$/i.test(url.hostname);
		const facebook = /^(?:www\.)?facebook\.com$/i.test(url.hostname) && url.pathname.startsWith("/messages/");
		if (url.protocol !== "https:" || (!messenger && !facebook)) return null;
		return `${sender.tab.id}:${sender.documentId}`;
	} catch {
		return null;
	}
}

// The panel gates first use too; this keeps a stale or modified view from starting work.
async function requireAcceptedTerms() {
	const saved = await chrome.storage.local.get(TERMS_STORAGE_KEY);
	if (!hasAcceptedTerms(saved[TERMS_STORAGE_KEY])) throw new Error(TERMS_REQUIRED);
}

async function preferences() {
	const saved = await chrome.storage.local.get(["envoyDeveloperMode", "envoyReplySettings"]);
	return {
		developerMode: saved.envoyDeveloperMode === true,
		replySettings: normalizeReplySettings(saved.envoyReplySettings),
	};
}

export default defineBackground(() => {
	const backend = createBackendClient();
	chrome.runtime.onConnect.addListener((port) => {
		if (port.name !== OWNER_HEARTBEAT_PORT) return;
		if (!port.sender || !connectorFor(port.sender)) {
			port.disconnect();
			return;
		}
		startBackgroundHeartbeat(port);
	});

	chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
		if (typeof message !== "object" || message === null || !("type" in message)) return;
		const connectorId = connectorFor(sender);
		if (!connectorId) return;
		const request = message as BackendRequest;
		const options = { signal: AbortSignal.timeout(8_000) };

		async function handle(connectorId: string): Promise<unknown> {
			switch (request.type) {
				case "envoy:health":
					return (await backend.health.query(undefined, options)).status === "ok";
				case "envoy:start":
					await requireAcceptedTerms();
					return backend.task.start.mutate(
						{ connectorId, goal: request.goal, snapshot: request.snapshot, ...(await preferences()) },
						options,
					);
				case "envoy:attach":
					await requireAcceptedTerms();
					return backend.task.attach.mutate(
						{ connectorId, taskId: request.taskId, snapshot: request.snapshot },
						options,
					);
				case "envoy:clear":
					return backend.task.clear.mutate({ connectorId, taskId: request.taskId }, options);
				case "envoy:control":
					return backend.task.control.mutate(
						{
							connectorId,
							taskId: request.taskId,
							action: request.action,
							...(request.text === undefined ? {} : { text: request.text }),
						},
						options,
					);
				case "envoy:sync":
					return backend.connector.sync.mutate(
						{ connectorId, snapshot: request.snapshot, ...(await preferences()) },
						options,
					);
				case "envoy:authorize":
					return backend.connector.authorize.mutate(
						{ connectorId, commandId: request.commandId, chatId: request.chatId, revision: request.revision },
						options,
					);
				case "envoy:report":
					return backend.connector.report.mutate(
						{ connectorId, commandId: request.commandId, result: request.result },
						options,
					);
				case "envoy:disconnect":
					return backend.connector.disconnect.mutate({ connectorId }, options);
				default:
					throw new Error("Unknown request");
			}
		}

		void handle(connectorId).then(
			(value) => respond({ ok: true, value }),
			(error: unknown) =>
				respond({
					ok: false,
					error:
						error instanceof Error && safeErrors.has(error.message)
							? error.message
							: "Backend unavailable or request rejected. Check the task and try again.",
				}),
		);
		return true;
	});
});
