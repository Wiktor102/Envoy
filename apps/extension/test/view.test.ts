import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import type { TaskState, TaskStatus } from "@envoy/contracts";
import type { ControllerState, EnvoyController } from "../src/controller";

// Supply Vite's static asset imports when running the view in Node.
const assets = registerHooks({
	load(url, context, nextLoad) {
		if (url.endsWith(".css?inline") || url.endsWith(".html?raw")) {
			return {
				format: "module",
				shortCircuit: true,
				source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))}`,
			};
		}
		return nextLoad(url, context);
	},
});
const { createEnvoyView } = await import("../src/ui/view");
assets.deregister();

const snapshot: NonNullable<ControllerState["snapshot"]> = {
	chatId: "chat-1",
	revision: "revision-1",
	messages: [{ id: "message-1", direction: "incoming", text: "Hello", attachments: [], reactions: [], replyTo: null }],
};

const task: TaskState = {
	id: "task-1",
	chatId: snapshot.chatId,
	goal: "Arrange a meeting",
	status: "waiting",
	detail: null,
	pendingReply: null,
};

function setup(t: TestContext) {
	const dom = new JSDOM("", { url: "https://www.messenger.com/t/chat-1" });
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		location: dom.window.location,
		MutationObserver: dom.window.MutationObserver,
	});
	let state: ControllerState = {
		snapshot,
		conversationStatus: "1 loaded message.",
		task: null,
		isOwner: false,
		error: null,
	};
	let publish!: (state: ControllerState) => void;
	const actions: string[] = [];
	const controller: EnvoyController = {
		subscribe(listener) {
			publish = listener;
			listener(state);
			return () => {};
		},
		async start() {},
		async attach() {},
		async clear() {},
		async control(action) {
			actions.push(action);
		},
		async checkHealth() {
			return true;
		},
		setControlsAvailable() {},
	};
	const view = createEnvoyView(() => {}, controller);
	document.body.append(view.host);
	view.selectTab(true);
	t.after(() => {
		view.destroy();
		dom.window.close();
	});
	return {
		actions,
		element<T extends HTMLElement = HTMLElement>(id: string) {
			return view.panel.querySelector<T>(`#envoy-${id}`)!;
		},
		update(patch: Partial<ControllerState>) {
			state = { ...state, ...patch };
			publish(state);
		},
	};
}

test("setup hides inactive control groups and conversation loss clears its preview", (t) => {
	const ui = setup(t);
	assert.equal(ui.element("task-controls").hidden, true);
	assert.equal(ui.element("reply-controls").hidden, true);
	assert.equal(ui.element("conversation-empty").hidden, true);
	ui.update({ snapshot: null });
	assert.equal(ui.element("conversation-empty").hidden, false);
	assert.equal(ui.element("conversation").children.length, 0);
	assert.equal(ui.element<HTMLButtonElement>("start").disabled, true);
});

test("reply controls keep interruption actions available during thinking and sending", async (t) => {
	const ui = setup(t);
	for (const status of ["thinking", "pending", "editing", "sending"] as const) {
		ui.update({
			task: {
				...task,
				status,
				pendingReply:
					status === "thinking"
						? null
						: {
								commandId: "reply-1",
								chatId: snapshot.chatId,
								expectedRevision: snapshot.revision,
								text: "Hi",
								sendAt: status === "editing" ? null : Date.now() + 10_000,
							},
			},
			isOwner: true,
		});
		assert.equal(ui.element("reply-controls").hidden, false, status);
		assert.equal(ui.element("task-controls").hidden, false, status);
		assert.equal(ui.element<HTMLButtonElement>("cancel").disabled, false, status);
		assert.equal(ui.element<HTMLButtonElement>("pause").disabled, false, status);
		assert.equal(ui.element<HTMLButtonElement>("edit").disabled, status !== "pending" && status !== "sending", status);
		assert.equal(ui.element<HTMLButtonElement>("send-now").disabled, status !== "pending", status);
	}
	ui.element<HTMLButtonElement>("cancel").click();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(ui.actions, ["cancel"]);
});

test("paused, ended, and unowned tasks keep recovery controls without reply actions", (t) => {
	const ui = setup(t);
	for (const status of ["waiting", "paused", "needs_user", "completed", "taken_over"] satisfies TaskStatus[]) {
		ui.update({ task: { ...task, status }, isOwner: true });
		assert.equal(ui.element("reply-controls").hidden, true, status);
		assert.equal(ui.element("task-controls").hidden, false, status);
		assert.equal(
			ui.element<HTMLButtonElement>("resume").disabled,
			status !== "paused" && status !== "needs_user",
			status,
		);
		assert.equal(ui.element("delete").hidden, status !== "completed" && status !== "taken_over", status);
	}
	ui.update({ task: { ...task, status: "paused" }, isOwner: false });
	assert.equal(ui.element("reconnect").hidden, false);
	assert.equal(ui.element<HTMLButtonElement>("reconnect").disabled, false);
	assert.equal(ui.element("reply-controls").hidden, true);
});
