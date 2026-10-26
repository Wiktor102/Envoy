import type { ConnectorSyncResult, ConversationSnapshot, SendResult, TaskControlAction, TaskState } from "@envoy/contracts";

// The background worker derives connector identity from Chrome's sender metadata.
export type BackendRequest =
	| { type: "envoy:health" }
	| { type: "envoy:start"; goal: string; snapshot: ConversationSnapshot }
	| { type: "envoy:attach"; taskId: string; snapshot: ConversationSnapshot }
	| { type: "envoy:clear"; taskId: string }
	| { type: "envoy:control"; taskId: string; action: TaskControlAction; text?: string }
	| { type: "envoy:sync"; snapshot: ConversationSnapshot | null }
	| { type: "envoy:authorize"; commandId: string; chatId: string; revision: string }
	| { type: "envoy:report"; commandId: string; result: SendResult }
	| { type: "envoy:disconnect" };

type BackendResults = {
	"envoy:health": boolean;
	"envoy:start": TaskState;
	"envoy:attach": TaskState;
	"envoy:clear": void;
	"envoy:control": TaskState;
	"envoy:sync": ConnectorSyncResult;
	"envoy:authorize": boolean;
	"envoy:report": TaskState | null;
	"envoy:disconnect": void;
};

type BackendResponse<T> = { ok: true; value: T } | { ok: false; error: string };

export async function callBackend<T extends BackendRequest>(request: T): Promise<BackendResults[T["type"]]> {
	const response = await chrome.runtime.sendMessage<BackendRequest, BackendResponse<BackendResults[T["type"]]>>(request);
	if (!response?.ok) throw new Error(response?.error ?? "Extension connection unavailable. Reload Messenger.");
	return response.value;
}
