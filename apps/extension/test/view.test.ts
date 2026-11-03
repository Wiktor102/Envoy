import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { MAX_TASK_TEXT_LENGTH, type TaskState, type TaskStatus } from "@envoy/contracts";
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
	messages: [
		{
			id: "message-1",
			direction: "incoming",
			sender: null,
			text: "Hello",
			attachments: [],
			reactions: [],
			replyTo: null,
		},
	],
	participants: [],
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

function preferenceStorage(initial: Record<string, unknown> = { envoyDeveloperMode: false }) {
	let values = structuredClone(initial);
	return {
		async get() {
			return structuredClone(values);
		},
		async set(items: Record<string, unknown>) {
			values = { ...values, ...structuredClone(items) };
		},
	};
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(t: TestContext, storage = preferenceStorage(), lang = "") {
	const dom = new JSDOM("", { url: "https://www.messenger.com/t/chat-1" });
	dom.window.document.documentElement.lang = lang;
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
		query<T extends HTMLElement = HTMLElement>(selector: string) {
			return (view.panel.getRootNode() as ShadowRoot).querySelector<T>(selector)!;
		},
		setText(id: string, value: string) {
			const field = (view.panel.getRootNode() as ShadowRoot).querySelector<HTMLTextAreaElement>(`#envoy-${id}`)!;
			field.value = value;
			field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		},
		changeField(id: string, value: string) {
			const field = (view.panel.getRootNode() as ShadowRoot).querySelector<HTMLInputElement>(`#envoy-${id}`)!;
			field.value = value;
			field.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		},
		setDetailsOpen(open: boolean) {
			const details = (view.panel.getRootNode() as ShadowRoot).querySelector("#envoy-agent-messages details")!;
			details.open = open;
			details.dispatchEvent(new dom.window.Event("toggle"));
		},
		dispatchKey(target: HTMLElement, key: string) {
			target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, composed: true }));
		},
		dispatchPointerDown(target: HTMLElement) {
			target.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, composed: true }));
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

test("diagnostics show the chat name and use it for incoming preview senders", (t) => {
	const ui = setup(t);
	const senders = () => [...ui.element("conversation").querySelectorAll("li strong")].map((sender) => sender.textContent);
	assert.equal(ui.element("chat-name").hidden, true);
	assert.deepEqual(senders(), ["Other person"]);
	ui.update({ snapshot: { ...snapshot, participants: ["Wiktor Golicz"] } });
	assert.equal(ui.element("chat-name").hidden, false);
	assert.equal(ui.element("chat-name").textContent, "Chat name: Wiktor Golicz");
	assert.deepEqual(senders(), ["Wiktor Golicz"]);
	ui.update({ snapshot: { ...snapshot, participants: [] } });
	assert.equal(ui.element("chat-name").hidden, true);
	assert.equal(ui.element("chat-name").textContent, "");
	assert.deepEqual(senders(), ["Other person"]);
	ui.update({ snapshot: null });
	assert.equal(ui.element("chat-name").hidden, true);
});

test("incoming preview shows the per-message sender where known", (t) => {
	const ui = setup(t);
	const senders = () => [...ui.element("conversation").querySelectorAll("li strong")].map((sender) => sender.textContent);
	const first = snapshot.messages[0]!;
	ui.update({
		snapshot: {
			...snapshot,
			revision: "revision-2",
			participants: ["Chat Name"],
			messages: [
				{ ...first, id: "message-1", sender: "Wiktor testowy" },
				{ ...first, id: "message-2", direction: "outgoing", text: "Hi", sender: "Ty" },
				{ ...first, id: "message-3", direction: "unknown", text: "?", sender: null },
			],
		},
	});
	assert.deepEqual(senders(), ["Wiktor testowy", "You", "Unknown sender"]);
});

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
	await flush();
	const developerDetails = ui.element("developer-details");
	assert.equal(developerDetails.hidden, true);
	for (const id of ["chat-id", "task-id", "task-chat", "conversation", "health"]) {
		assert.equal(developerDetails.contains(ui.element(id)), true, id);
	}
	ui.update({ task: { ...task, detail: { code: "agent_message", text: "Can you meet on Friday?" } }, isOwner: true });
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

test("settings popover holds the reply settings and the developer switch", async (t) => {
	const ui = setup(t);
	await flush();
	const settings = ui.element<HTMLButtonElement>("settings");
	assert.equal(settings.getAttribute("aria-controls"), "envoy-settings-popover");
	assert.equal(settings.getAttribute("aria-expanded"), "false");
	assert.equal(settings.textContent?.includes("Envoy settings"), true);
	assert.equal(settings.querySelector("svg") !== null, true);
	assert.equal(settings.closest(".toolbar") !== null, true);
	assert.equal(settings.closest('[role="tablist"]'), null);
	const popover = ui.element("settings-popover");
	assert.equal(popover.getAttribute("role"), "dialog");
	assert.equal(popover.hidden, true);
	for (const id of ["auto-send", "delay", "delay-min", "delay-max", "delay-hint", "developer-mode"]) {
		assert.equal(popover.contains(ui.element(id)), true, id);
	}
	settings.click();
	assert.equal(popover.hidden, false);
	assert.equal(settings.getAttribute("aria-expanded"), "true");
	settings.click();
	assert.equal(popover.hidden, true);
	assert.equal(settings.getAttribute("aria-expanded"), "false");
	settings.click();
	ui.dispatchKey(ui.element("panel"), "Escape");
	assert.equal(popover.hidden, true);
	settings.click();
	ui.dispatchPointerDown(document.body);
	assert.equal(popover.hidden, true);
	settings.click();
	ui.dispatchPointerDown(ui.element("delay-max"));
	assert.equal(popover.hidden, false);
	ui.dispatchPointerDown(settings);
	assert.equal(popover.hidden, false);
	ui.dispatchPointerDown(ui.element("goal"));
	assert.equal(popover.hidden, true);
	settings.click();
	assert.equal(popover.hidden, false);
	ui.selectTab(false);
	assert.equal(settings.hidden, true);
	assert.equal(popover.hidden, true);
	ui.selectTab(true);
	assert.equal(ui.element("settings").hidden, false);
	assert.equal(ui.element("settings-popover").hidden, true);
});

test("developer switch remembers both choices across remounts and stays outside tab navigation", async (t) => {
	const storage = preferenceStorage();
	const ui = setup(t, storage);

	await flush();
	ui.element<HTMLButtonElement>("settings").click();
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
	assert.equal(ui.element("settings").hidden, true);
	ui.selectTab(true);
	assert.equal(ui.element("settings").hidden, false);
	ui.element<HTMLButtonElement>("settings").click();
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
	await flush();
	assert.equal(ui.element("developer-details").hidden, true);
	ui.element<HTMLButtonElement>("developer-mode").click();
	await flush();
	assert.equal(ui.element("developer-details").hidden, false);
});

test("reply sending defaults to auto-send after a 10-second countdown", async (t) => {
	const ui = setup(t);
	await flush();
	const toggle = ui.element<HTMLButtonElement>("auto-send");
	assert.equal(toggle.getAttribute("role"), "switch");
	assert.equal(toggle.getAttribute("aria-checked"), "true");
	assert.equal(ui.element<HTMLInputElement>("delay-min").value, "10");
	assert.equal(ui.element<HTMLInputElement>("delay-max").value, "10");
	assert.equal(ui.element<HTMLInputElement>("delay-min").disabled, false);
	assert.equal(ui.element("delay-hint").textContent, "Replies send after a 10-second countdown.");
	assert.equal(ui.element("goal-hint").hidden, false);
	assert.equal(ui.element("goal-hint").textContent, `0 / ${MAX_TASK_TEXT_LENGTH} characters`);
});

test("the auto-send switch and delay range are remembered across remounts", async (t) => {
	const storage = preferenceStorage();
	const ui = setup(t, storage);
	await flush();
	ui.changeField("delay-max", "25");
	ui.changeField("delay-min", "5");
	assert.equal(ui.element("delay-hint").textContent, "Replies send after a random 5–25-second countdown.");
	ui.element<HTMLButtonElement>("auto-send").click();
	assert.equal(ui.element<HTMLInputElement>("delay-min").disabled, true);
	assert.equal(ui.element<HTMLInputElement>("delay-max").disabled, true);
	assert.equal(ui.element("delay").getAttribute("aria-disabled"), "true");
	assert.equal(ui.element("delay-hint").textContent, "Replies wait until you choose Send now.");
	await flush();
	assert.deepEqual((await storage.get()).envoyReplySettings, {
		autoSend: false,
		minDelaySeconds: 5,
		maxDelaySeconds: 25,
	});
	ui.remount();
	await flush();
	assert.equal(ui.element("auto-send").getAttribute("aria-checked"), "false");
	assert.equal(ui.element<HTMLInputElement>("delay-min").value, "5");
	assert.equal(ui.element<HTMLInputElement>("delay-max").value, "25");
});

test("delay edits stay whole, bounded, and ordered", async (t) => {
	const storage = preferenceStorage();
	const ui = setup(t, storage);
	await flush();
	const range = () => [ui.element<HTMLInputElement>("delay-min").value, ui.element<HTMLInputElement>("delay-max").value];
	ui.changeField("delay-min", "30");
	assert.deepEqual(range(), ["30", "30"]);
	ui.changeField("delay-max", "12.4");
	assert.deepEqual(range(), ["12", "12"]);
	ui.changeField("delay-max", "9000");
	assert.deepEqual(range(), ["12", "600"]);
	ui.changeField("delay-min", "0");
	assert.deepEqual(range(), ["1", "600"]);
	ui.changeField("delay-min", "");
	assert.deepEqual(range(), ["1", "600"]);
	await flush();
	assert.deepEqual((await storage.get()).envoyReplySettings, {
		autoSend: true,
		minDelaySeconds: 1,
		maxDelaySeconds: 600,
	});
});

test("stored reply settings from older or broken data fall back to defaults", async (t) => {
	const ui = setup(
		t,
		preferenceStorage({ envoyReplySettings: { autoSend: "yes", minDelaySeconds: 40, maxDelaySeconds: 20 } }),
	);
	await flush();
	assert.equal(ui.element("auto-send").getAttribute("aria-checked"), "true");
	assert.equal(ui.element<HTMLInputElement>("delay-min").value, "40");
	assert.equal(ui.element<HTMLInputElement>("delay-max").value, "40");
});

test("an active task notes that reply settings apply right away", async (t) => {
	const ui = setup(t);
	await flush();
	ui.update({ task, isOwner: true });
	ui.element<HTMLButtonElement>("goal-toggle").click();
	assert.equal(ui.element("goal-hint").hidden, false);
	assert.equal(
		ui.element("delay-hint").textContent,
		"Replies send after a 10-second countdown. Changes apply right away.",
	);
	ui.element<HTMLButtonElement>("auto-send").click();
	ui.update({
		task: {
			...task,
			status: "pending",
			pendingReply: { commandId: "c1", chatId: task.chatId, expectedRevision: "revision-1", text: "Hi", sendAt: null },
		},
	});
	assert.equal(ui.element("countdown").textContent, "Waiting for Send now.");
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
	await flush();
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
			detail: { code: "agent_message", text: "Is Friday allowed?" },
			agentChat: [
				{ id: "q1", role: "agent", text: "Is Friday allowed?", body: null, createdAt: 1 },
				{ id: "a1", role: "user", text: "Yes, after 3.", body: null, createdAt: 2 },
				{ id: "e1", role: "event", text: "Reply sent.", body: "It's okay!", createdAt: 3 },
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
	assert.equal(items[2]!.classList.contains("tool-call"), true);
	assert.equal(items[2]!.querySelector("summary")?.textContent, "Reply sent.");
	assert.equal(items[2]!.querySelector("p")?.textContent, "It's okay!");
	assert.equal(ui.element("agent-messages").closest("#envoy-developer-details"), null);
});

test("answers send to the agent without rewriting the goal", async (t) => {
	const ui = setup(t);
	ui.update({
		task: { ...task, status: "needs_user", detail: { code: "agent_message", text: "Is Friday allowed?" } },
		isOwner: true,
	});
	const goal = ui.element<HTMLTextAreaElement>("goal");
	assert.equal(goal.value, "Arrange a meeting");
	assert.equal(ui.element("footer").hidden, false);
	const send = ui.element<HTMLButtonElement>("answer-send");
	assert.equal(send.disabled, true);
	ui.setText("answer-text", "Yes, after 3.");
	assert.equal(send.disabled, false);
	send.click();
	await flush();
	assert.deepEqual(ui.actions, ["answer-agent"]);
	assert.deepEqual(ui.texts, ["Yes, after 3."]);
	assert.equal(ui.element<HTMLTextAreaElement>("answer-text").value, "");
	assert.equal(goal.value, "Arrange a meeting");
});

test("limited inputs show character counts and block over-limit submits", (t) => {
	const ui = setup(t);
	const over = "x".repeat(MAX_TASK_TEXT_LENGTH + 1);
	const start = ui.element<HTMLButtonElement>("start");
	assert.equal(ui.element("goal-hint").textContent, `0 / ${MAX_TASK_TEXT_LENGTH} characters`);
	assert.equal(start.disabled, true);
	ui.setText("goal", "Arrange a meeting");
	assert.equal(ui.element("goal-hint").textContent, `17 / ${MAX_TASK_TEXT_LENGTH} characters`);
	assert.equal(start.disabled, false);
	ui.setText("goal", over);
	assert.equal(
		ui.element("goal-hint").textContent,
		`${MAX_TASK_TEXT_LENGTH + 1} / ${MAX_TASK_TEXT_LENGTH} characters. Too long, shorten the text.`,
	);
	assert.equal(start.disabled, true);

	ui.update({
		task: { ...task, status: "needs_user", detail: { code: "agent_message", text: "Is Friday allowed?" } },
		isOwner: true,
	});
	const updateGoal = ui.element<HTMLButtonElement>("update-goal");
	ui.setText("goal", "Arrange a meeting");
	assert.equal(
		ui.element("goal-hint").textContent,
		`Changes apply after you choose Update instructions. 17 / ${MAX_TASK_TEXT_LENGTH} characters`,
	);
	assert.equal(updateGoal.disabled, true);
	ui.setText("goal", "Arrange a meeting on Thursday");
	assert.equal(updateGoal.disabled, false);
	ui.setText("goal", over);
	assert.equal(updateGoal.disabled, true);

	const answerSend = ui.element<HTMLButtonElement>("answer-send");
	ui.setText("answer-text", "Yes, after 3.");
	assert.equal(ui.element("answer-hint").textContent, `13 / ${MAX_TASK_TEXT_LENGTH} characters`);
	assert.equal(answerSend.disabled, false);
	ui.setText("answer-text", over);
	assert.equal(
		ui.element("answer-hint").textContent,
		`${MAX_TASK_TEXT_LENGTH + 1} / ${MAX_TASK_TEXT_LENGTH} characters. Too long, shorten the text.`,
	);
	assert.equal(answerSend.disabled, true);

	ui.update({
		task: {
			...task,
			status: "editing",
			pendingReply: {
				commandId: "reply-1",
				chatId: snapshot.chatId,
				expectedRevision: snapshot.revision,
				text: "Hi",
				sendAt: null,
			},
		},
		isOwner: true,
	});
	const saveEdit = ui.element<HTMLButtonElement>("save-edit");
	assert.equal(
		ui.element("edit-hint").textContent,
		`Saving keeps the reply paused. Use Send now when it is ready. 2 / ${MAX_TASK_TEXT_LENGTH} characters`,
	);
	assert.equal(saveEdit.disabled, false);
	ui.setText("reply-edit", over);
	assert.equal(saveEdit.disabled, true);
});

test("agent history stays hidden from other tabs and read-only after the task ends", (t) => {
	const ui = setup(t);
	const chatting: TaskState = {
		...task,
		status: "needs_user",
		agentChat: [{ id: "q1", role: "agent", text: "Is Friday allowed?", body: null, createdAt: 1 }],
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
	await flush();
	assert.deepEqual(ui.actions, ["update-goal"]);
	assert.deepEqual(ui.texts, ["Arrange a meeting on Thursday"]);
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	assert.equal(ui.element("instructions").hidden, true);
});

test("agent state shows once and hides when it repeats the last Envoy message", (t) => {
	const ui = setup(t);
	ui.update({ task: { ...task, status: "thinking", detail: { code: "considering_conversation" } }, isOwner: true });
	assert.equal(ui.element("agent-state").hidden, false);
	assert.equal(ui.element("agent-state").textContent, "Considering the conversation.");
	ui.update({
		task: {
			...task,
			status: "needs_user",
			detail: { code: "agent_message", text: "Is Friday allowed?" },
			agentChat: [{ id: "q1", role: "agent", text: "Is Friday allowed?", body: null, createdAt: 1 }],
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

test("open tool calls stay open across re-renders but reset for a new task", (t) => {
	const ui = setup(t);
	const chatting: TaskState = {
		...task,
		status: "waiting",
		detail: null,
		agentChat: [{ id: "e1", role: "event", text: "Reply sent.", body: "It's okay!", createdAt: 1 }],
	};
	ui.update({ task: chatting, isOwner: true });
	ui.setDetailsOpen(true);
	ui.update({ task: { ...chatting }, isOwner: true });
	assert.equal(ui.element("agent-messages").querySelector("details")!.open, true);
	ui.update({
		task: {
			...chatting,
			agentChat: [...chatting.agentChat, { id: "a1", role: "user", text: "Thanks.", body: null, createdAt: 2 }],
		},
		isOwner: true,
	});
	assert.equal(ui.element("agent-messages").querySelector("details")!.open, true);
	ui.update({ task: { ...chatting, id: "task-2" }, isOwner: true });
	assert.equal(ui.element("agent-messages").querySelector("details")!.open, false);
});

test("thinking shows a subtle cancel link while reply buttons live in the pending card", async (t) => {
	const ui = setup(t);
	ui.update({ task: { ...task, status: "thinking", detail: { code: "considering_conversation" } }, isOwner: true });
	assert.equal(ui.element("pending").hidden, true);
	assert.equal(ui.element("cancel-thinking").hidden, false);
	assert.equal(ui.element("reply-controls").parentElement?.id, "envoy-pending");
	ui.element<HTMLButtonElement>("cancel-thinking").click();
	await flush();
	assert.deepEqual(ui.actions, ["cancel"]);
	ui.update({
		task: {
			...task,
			status: "pending",
			pendingReply: {
				commandId: "reply-1",
				chatId: snapshot.chatId,
				expectedRevision: snapshot.revision,
				text: "Hi",
				sendAt: Date.now() + 10_000,
			},
		},
		isOwner: true,
	});
	assert.equal(ui.element("cancel-thinking").hidden, true);
	assert.equal(ui.element("pending").hidden, false);
	assert.equal(ui.element("reply-controls").hidden, false);
	ui.update({ task: { ...task, status: "thinking" }, isOwner: false });
	assert.equal(ui.element("cancel-thinking").hidden, true);
});

test("unowned tasks explain who controls them and hide an empty header", (t) => {
	const ui = setup(t);
	ui.update({ task: { ...task, status: "paused" }, isOwner: false });
	assert.equal(ui.element("header").hidden, true);
	assert.equal(ui.element("owner-hint").hidden, false);
	assert.equal(ui.element("owner-hint").textContent, "This task is paused. Reconnect to control it from this tab.");
	assert.equal(ui.element("reconnect").hidden, false);
	assert.equal(ui.element("reconnect").closest("#envoy-thread") !== null, true);
	ui.update({ task: { ...task, status: "waiting" }, isOwner: false });
	assert.equal(ui.element("header").hidden, true);
	assert.equal(ui.element("owner-hint").hidden, false);
	assert.equal(ui.element("owner-hint").textContent, "This task is controlled by another tab.");
	ui.update({ task: { ...task, status: "waiting" }, isOwner: true });
	assert.equal(ui.element("header").hidden, false);
	assert.equal(ui.element("owner-hint").hidden, true);
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
	assert.equal(ui.element("header").hidden, true);
	assert.equal(ui.element("reconnect").hidden, false);
	assert.equal(ui.element<HTMLButtonElement>("reconnect").disabled, false);
	assert.equal(ui.element("reply-controls").hidden, true);
	assert.equal(ui.element("pause").hidden, true);
	assert.equal(ui.element("footer").hidden, true);
});

test("a polish page renders a polish panel", async (t) => {
	const ui = setup(t, preferenceStorage(), "pl");
	await flush();
	assert.equal(ui.query("#chats-tab").textContent, "Czaty");
	assert.equal(ui.query(".tabs").getAttribute("aria-label"), "Pasek boczny czatów");
	assert.equal(ui.element("start").textContent, "Rozpocznij zadanie");
	assert.equal(ui.element("goal-title").textContent, "Twoje instrukcje");
	assert.equal(
		ui.element<HTMLTextAreaElement>("goal").placeholder,
		"Umów się na kawę w przyszłym tygodniu. Mogę we wtorek lub czwartek po 15:00. Zapytaj mnie przed potwierdzeniem miejsca.",
	);
	assert.equal(ui.element("delay-hint").textContent, "Odpowiedzi wyślą się po odliczaniu 10 s.");
	assert.equal(ui.element("goal-hint").textContent, `0 / ${MAX_TASK_TEXT_LENGTH} znaków`);
	assert.equal(ui.element("pause").getAttribute("aria-label"), "Wstrzymaj");
	assert.equal(ui.element("conversation-empty").textContent, "Nie załadowano jeszcze żadnych wiadomości.");
	const senders = () => [...ui.element("conversation").querySelectorAll("li strong")].map((sender) => sender.textContent);
	assert.deepEqual(senders(), ["Inna osoba"]);
	ui.update({ task: { ...task, status: "waiting" }, isOwner: true });
	assert.equal(ui.element("agent-state").textContent, "Oczekiwanie na nową wiadomość.");
	ui.update({ task: { ...task, status: "pending", detail: { code: "auto_send_off" } }, isOwner: true });
	assert.equal(
		ui.element("agent-state").textContent,
		"Automatyczne wysyłanie jest wyłączone. Wybierz Wyślij teraz, gdy odpowiedź będzie gotowa.",
	);
	ui.update({
		task: {
			...task,
			status: "pending",
			pendingReply: { commandId: "c1", chatId: task.chatId, expectedRevision: "revision-1", text: "Hi", sendAt: null },
		},
	});
	assert.equal(ui.element("countdown").textContent, "Automatyczne wysyłanie jest zatrzymane.");
	ui.update({ task: { ...task, status: "waiting" }, isOwner: false });
	assert.equal(ui.element("owner-hint").textContent, "To zadanie jest sterowane z innej karty.");
	ui.update({ snapshot: { ...snapshot, chatId: "another-chat" } });
	assert.equal(
		ui.element("task-notice").textContent,
		"To zadanie należy do innej rozmowy. Otwórz jej dedykowaną kartę, aby kontynuować.",
	);
});

test("the panel follows a page language switch without reload", async (t) => {
	const ui = setup(t);
	ui.update({ task: { ...task, status: "waiting" }, isOwner: true });
	assert.equal(ui.query("#chats-tab").textContent, "Chats");
	assert.equal(ui.element("agent-state").textContent, "Waiting for a new message.");
	document.documentElement.lang = "pl";
	await flush();
	assert.equal(ui.query("#chats-tab").textContent, "Czaty");
	assert.equal(ui.element("agent-state").textContent, "Oczekiwanie na nową wiadomość.");
	assert.equal(ui.element("start").textContent, "Rozpocznij zadanie");
	document.documentElement.lang = "en";
	await flush();
	assert.equal(ui.query("#chats-tab").textContent, "Chats");
	assert.equal(ui.element("agent-state").textContent, "Waiting for a new message.");
});
