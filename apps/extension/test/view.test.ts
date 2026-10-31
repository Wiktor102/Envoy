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
	agentChat: [],
};

function preferenceStorage(initialValue: unknown = false) {
	let value = initialValue;
	return {
		async get() {
			return { envoyDeveloperMode: value };
		},
		async set(items: { envoyDeveloperMode: boolean }) {
			value = items.envoyDeveloperMode;
		},
	};
}

function setup(t: TestContext, storage = preferenceStorage()) {
	const dom = new JSDOM("", { url: "https://www.messenger.com/t/chat-1" });
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		location: dom.window.location,
		MutationObserver: dom.window.MutationObserver,
		chrome: { storage: { local: storage } },
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
	const texts: (string | undefined)[] = [];
	const controller: EnvoyController = {
		subscribe(listener) {
			publish = listener;
			listener(state);
			return () => {};
		},
		async start() {},
		async attach() {},
		async clear() {},
		async control(action, text) {
			actions.push(action);
			texts.push(text);
		},
		async checkHealth() {
			return true;
		},
		setControlsAvailable() {},
	};
	let view = createEnvoyView(() => {}, controller);
	document.body.append(view.host);
	view.selectTab(true);
	t.after(() => {
		view.destroy();
		dom.window.close();
	});
	return {
		actions,
		texts,
		element<T extends HTMLElement = HTMLElement>(id: string) {
			return (view.panel.getRootNode() as ShadowRoot).querySelector<T>(`#envoy-${id}`)!;
		},
		setText(id: string, value: string) {
			const field = (view.panel.getRootNode() as ShadowRoot).querySelector<HTMLTextAreaElement>(`#envoy-${id}`)!;
			field.value = value;
			field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		},
		selectTab(showEnvoy: boolean) {
			view.selectTab(showEnvoy);
		},
		remount() {
			view.destroy();
			view.host.remove();
			view = createEnvoyView(() => {}, controller);
			document.body.append(view.host);
			view.selectTab(true);
		},
		update(patch: Partial<ControllerState>) {
			state = { ...state, ...patch };
			publish(state);
		},
	};
}

test("setup shows the start form while the thread and footer stay hidden", (t) => {
	const ui = setup(t);
	assert.equal(ui.element("header").hidden, true);
	assert.equal(ui.element("instructions").hidden, false);
	assert.equal(ui.element("start").hidden, false);
	assert.equal(ui.element("thread").hidden, true);
	assert.equal(ui.element("footer").hidden, true);
	assert.equal(ui.element("reply-controls").hidden, true);
	assert.equal(ui.element("goal-toggle").hidden, true);
	for (const id of ["pause", "resume", "reconnect", "take-over", "delete"]) {
		assert.equal(ui.element(id).hidden, true, id);
	}
	assert.equal(ui.element("conversation-empty").hidden, true);
	ui.update({ snapshot: null });
	assert.equal(ui.element("conversation-empty").hidden, false);
	assert.equal(ui.element("conversation").children.length, 0);
	assert.equal(ui.element<HTMLButtonElement>("start").disabled, true);
});

test("developer mode hides history and diagnostics by default but keeps actionable notices visible", async (t) => {
	const ui = setup(t);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const developerDetails = ui.element("developer-details");
	assert.equal(developerDetails.hidden, true);
	for (const id of ["chat-id", "task-id", "task-chat", "conversation", "health"]) {
		assert.equal(developerDetails.contains(ui.element(id)), true, id);
	}
	ui.update({ task: { ...task, detail: "Can you meet on Friday?" }, isOwner: true });
	assert.equal(ui.element("task-id").textContent, "Task ID: task-1");
	assert.equal(ui.element("agent-state").hidden, false);
	assert.equal(ui.element("agent-state").closest("#envoy-developer-details"), null);
	ui.update({ snapshot: null, conversationStatus: "Scroll to the bottom or reload this tab." });
	assert.equal(ui.element("conversation-notice").hidden, false);
	assert.equal(ui.element("conversation-notice").textContent, "Scroll to the bottom or reload this tab.");
	ui.update({ snapshot: { ...snapshot, chatId: "another-chat" } });
	assert.equal(ui.element("conversation-notice").hidden, true);
	assert.equal(ui.element("task-notice").hidden, false);
	assert.equal(ui.element("task-notice").closest("#envoy-developer-details"), null);
});

test("developer switch remembers both choices across remounts and stays outside tab navigation", async (t) => {
	const storage = preferenceStorage();
	const ui = setup(t, storage);
	const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
	await flush();
	const toggle = ui.element<HTMLButtonElement>("developer-mode");
	assert.equal(toggle.getAttribute("role"), "switch");
	assert.equal(toggle.getAttribute("aria-checked"), "false");
	assert.equal(toggle.closest('[role="tablist"]'), null);
	toggle.click();
	assert.equal(toggle.getAttribute("aria-checked"), "true");
	assert.equal(ui.element("developer-details").hidden, false);
	await flush();
	assert.deepEqual(await storage.get(), { envoyDeveloperMode: true });
	ui.remount();
	await flush();
	assert.equal(ui.element("developer-details").hidden, false);
	ui.selectTab(false);
	assert.equal(ui.element("developer-mode").hidden, true);
	ui.selectTab(true);
	assert.equal(ui.element("developer-mode").hidden, false);
	ui.element<HTMLButtonElement>("developer-mode").click();
	assert.equal(ui.element("developer-details").hidden, true);
	await flush();
	assert.deepEqual(await storage.get(), { envoyDeveloperMode: false });
	ui.remount();
	await flush();
	assert.equal(ui.element("developer-mode").getAttribute("aria-checked"), "false");
	assert.equal(ui.element("developer-details").hidden, true);
});

test("a late preference read cannot undo a toggle and slow writes preserve the last choice", async (t) => {
	let finishRead!: (value: { envoyDeveloperMode: boolean }) => void;
	let finishWrite!: () => void;
	const writes: boolean[] = [];
	const ui = setup(t, {
		get: () =>
			new Promise((resolve) => {
				finishRead = resolve;
			}),
		async set(items) {
			writes.push(items.envoyDeveloperMode);
			if (writes.length === 1)
				await new Promise<void>((resolve) => {
					finishWrite = resolve;
				});
		},
	});
	const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
	const toggle = ui.element<HTMLButtonElement>("developer-mode");
	toggle.click();
	finishRead({ envoyDeveloperMode: false });
	await flush();
	assert.equal(ui.element("developer-details").hidden, false);
	toggle.click();
	await flush();
	assert.deepEqual(writes, [true]);
	finishWrite();
	await flush();
	assert.deepEqual(writes, [true, false]);
	assert.equal(toggle.getAttribute("aria-checked"), "false");
	assert.equal(ui.element("developer-details").hidden, true);
});

test("unavailable preference storage leaves the toggle usable", async (t) => {
	const unavailable = async () => {
		throw new Error("Storage unavailable");
	};
	const ui = setup(t, { get: unavailable, set: unavailable });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(ui.element("developer-details").hidden, true);
	ui.element<HTMLButtonElement>("developer-mode").click();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(ui.element("developer-details").hidden, false);
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
		assert.equal(ui.element("pause").hidden, false, status);
		assert.equal(ui.element("take-over").hidden, false, status);
		assert.equal(ui.element<HTMLButtonElement>("cancel").disabled, false, status);
		assert.equal(ui.element<HTMLButtonElement>("pause").disabled, false, status);
		assert.equal(ui.element<HTMLButtonElement>("edit").disabled, status !== "pending" && status !== "sending", status);
		assert.equal(ui.element<HTMLButtonElement>("send-now").disabled, status !== "pending", status);
	}
	ui.element<HTMLButtonElement>("cancel").click();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(ui.actions, ["cancel"]);
});

test("the reply text stays visible while it is being sent", (t) => {
	const ui = setup(t);
	const pendingReply = {
		commandId: "reply-1",
		chatId: snapshot.chatId,
		expectedRevision: snapshot.revision,
		text: "Tuesday works.",
		sendAt: Date.now(),
	};
	ui.update({ task: { ...task, status: "pending", pendingReply }, isOwner: true });
	ui.update({ task: { ...task, status: "sending", pendingReply: null }, isOwner: true });
	assert.equal(ui.element("pending").hidden, false);
	assert.equal(ui.element("pending-text").textContent, "Tuesday works.");
	assert.equal(ui.element("countdown").textContent, "Sending...");
	ui.update({ task: { ...task, status: "waiting", pendingReply: null }, isOwner: true });
	assert.equal(ui.element("pending").hidden, true);
	ui.update({ task: { ...task, status: "sending", pendingReply: null }, isOwner: true });
	assert.equal(ui.element("pending").hidden, true);
});

test("agent thread renders questions, answers, and events without a frame", (t) => {
	const ui = setup(t);
	ui.update({
		task: {
			...task,
			status: "needs_user",
			detail: "Is Friday allowed?",
			agentChat: [
				{ id: "q1", role: "agent", text: "Is Friday allowed?", createdAt: 1 },
				{ id: "a1", role: "user", text: "Yes, after 3.", createdAt: 2 },
				{ id: "e1", role: "event", text: "Reply sent.", createdAt: 3 },
			],
		},
		isOwner: true,
	});
	assert.equal(ui.element("thread").hidden, false);
	assert.equal(ui.element("agent-empty").hidden, true);
	assert.equal(ui.element("agent-messages").parentElement?.id, "envoy-thread");
	const items = ui.element("agent-messages").querySelectorAll("li");
	assert.equal(items.length, 3);
	assert.equal(items[0]!.dataset.role, "agent");
	assert.equal(items[0]!.querySelector("strong")?.textContent, "Envoy");
	assert.match(items[0]!.textContent ?? "", /Is Friday allowed\?/);
	assert.equal(items[1]!.dataset.role, "user");
	assert.equal(items[1]!.querySelector("strong")?.textContent, "You");
	assert.equal(items[2]!.dataset.role, "event");
	assert.equal(items[2]!.querySelector("strong"), null);
	assert.equal(ui.element("agent-messages").closest("#envoy-developer-details"), null);
});

test("answers send to the agent without rewriting the goal", async (t) => {
	const ui = setup(t);
	ui.update({ task: { ...task, status: "needs_user", detail: "Is Friday allowed?" }, isOwner: true });
	const goal = ui.element<HTMLTextAreaElement>("goal");
	assert.equal(goal.value, "Arrange a meeting");
	assert.equal(ui.element("footer").hidden, false);
	const send = ui.element<HTMLButtonElement>("answer-send");
	assert.equal(send.disabled, true);
	ui.setText("answer-text", "Yes, after 3.");
	assert.equal(send.disabled, false);
	send.click();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(ui.actions, ["answer-agent"]);
	assert.deepEqual(ui.texts, ["Yes, after 3."]);
	assert.equal(ui.element<HTMLTextAreaElement>("answer-text").value, "");
	assert.equal(goal.value, "Arrange a meeting");
});

test("agent history stays hidden from other tabs and read-only after the task ends", (t) => {
	const ui = setup(t);
	const chatting: TaskState = {
		...task,
		status: "needs_user",
		agentChat: [{ id: "q1", role: "agent", text: "Is Friday allowed?", createdAt: 1 }],
	};
	ui.update({ task: chatting, isOwner: false });
	assert.equal(ui.element("agent-messages").querySelectorAll("li").length, 0);
	assert.equal(ui.element("agent-empty").hidden, true);
	assert.equal(ui.element("goal-toggle").hidden, true);
	assert.equal(ui.element("footer").hidden, true);
	ui.update({ task: { ...chatting, status: "completed" }, isOwner: true });
	assert.equal(ui.element("thread").hidden, false);
	assert.equal(ui.element("footer").hidden, true);
	ui.update({ task: { ...task, status: "completed" }, isOwner: true });
	assert.equal(ui.element("thread").hidden, false);
	assert.equal(ui.element("agent-empty").hidden, true);
	assert.equal(ui.element("footer").hidden, true);
});

test("header shows the goal with icon actions for an active task", (t) => {
	const ui = setup(t);
	ui.update({ task: { ...task, status: "waiting" }, isOwner: true });
	assert.equal(ui.element("header").hidden, false);
	assert.equal(ui.element("agent-state").textContent, "Waiting for a new message.");
	assert.equal(ui.element("agent-state").closest("#envoy-header"), null);
	const threadChildren = [...ui.element("thread").children];
	assert.ok(threadChildren.indexOf(ui.element("agent-state")) > threadChildren.indexOf(ui.element("agent-messages")));
	assert.equal(ui.element("goal-toggle").hidden, false);
	assert.equal(ui.element("goal-toggle").querySelector(".goal-label")?.textContent, "Goal");
	assert.equal(ui.element("goal-text").textContent, "Arrange a meeting");
	assert.equal(ui.element("goal-toggle").getAttribute("aria-expanded"), "false");
	assert.equal(ui.element("instructions").hidden, true);
	assert.equal(ui.element("pause").hidden, false);
	assert.equal(ui.element("take-over").hidden, false);
	assert.equal(ui.element("resume").hidden, true);
	assert.equal(ui.element("reconnect").hidden, true);
	assert.equal(ui.element("delete").hidden, true);
});

test("goal toggle opens the editor and updating closes it", async (t) => {
	const ui = setup(t);
	ui.update({ task: { ...task, status: "waiting" }, isOwner: true });
	const toggle = ui.element<HTMLButtonElement>("goal-toggle");
	toggle.click();
	assert.equal(toggle.getAttribute("aria-expanded"), "true");
	assert.equal(ui.element("instructions").hidden, false);
	assert.equal(ui.element("update-goal").hidden, false);
	toggle.click();
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	assert.equal(ui.element("instructions").hidden, true);
	toggle.click();
	ui.setText("goal", "Arrange a meeting on Thursday");
	ui.element<HTMLButtonElement>("update-goal").click();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(ui.actions, ["update-goal"]);
	assert.deepEqual(ui.texts, ["Arrange a meeting on Thursday"]);
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	assert.equal(ui.element("instructions").hidden, true);
});

test("agent state shows once and hides when it repeats the last Envoy message", (t) => {
	const ui = setup(t);
	ui.update({ task: { ...task, status: "thinking", detail: "Considering the conversation." }, isOwner: true });
	assert.equal(ui.element("agent-state").hidden, false);
	assert.equal(ui.element("agent-state").textContent, "Considering the conversation.");
	ui.update({
		task: {
			...task,
			status: "needs_user",
			detail: "Is Friday allowed?",
			agentChat: [{ id: "q1", role: "agent", text: "Is Friday allowed?", createdAt: 1 }],
		},
		isOwner: true,
	});
	assert.equal(ui.element("agent-state").hidden, true);
	ui.update({ task: { ...task, status: "waiting", detail: null }, isOwner: true });
	assert.equal(ui.element("agent-state").hidden, false);
	assert.equal(ui.element("agent-state").textContent, "Waiting for a new message.");
	ui.update({ task: { ...task, status: "paused", detail: null }, isOwner: false });
	assert.equal(ui.element("agent-state").hidden, false);
	assert.equal(ui.element("agent-state").textContent, "Paused. (Not connected to this tab.)");
});

test("paused, ended, and unowned tasks keep recovery actions without reply actions", (t) => {
	const ui = setup(t);
	for (const status of ["waiting", "paused", "needs_user", "completed", "taken_over"] satisfies TaskStatus[]) {
		ui.update({ task: { ...task, status }, isOwner: true });
		assert.equal(ui.element("reply-controls").hidden, true, status);
		const runnable = status !== "completed" && status !== "taken_over";
		assert.equal(ui.element("pause").hidden, !runnable || status === "paused", status);
		assert.equal(ui.element("resume").hidden, status !== "paused" && status !== "needs_user", status);
		assert.equal(
			ui.element<HTMLButtonElement>("resume").disabled,
			status !== "paused" && status !== "needs_user",
			status,
		);
		assert.equal(ui.element("take-over").hidden, !runnable, status);
		assert.equal(ui.element("delete").hidden, status !== "completed" && status !== "taken_over", status);
	}
	ui.update({ task: { ...task, status: "paused" }, isOwner: false });
	assert.equal(ui.element("reconnect").hidden, false);
	assert.equal(ui.element<HTMLButtonElement>("reconnect").disabled, false);
	assert.equal(ui.element("reply-controls").hidden, true);
	assert.equal(ui.element("pause").hidden, true);
	assert.equal(ui.element("footer").hidden, true);
});
