import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationMessage, ConversationSnapshot } from "@envoy/contracts";
import { resolveReply, setup, snapshot } from "./support/task-fixtures.js";

test("unknown direction and unsupported content do not trigger the model", () => {
	{
		const { agent, service } = setup();
		const result = service.start("owner", "Arrange a meeting", snapshot("r1", "Hello", "unknown"));
		assert.equal(result.status, "needs_user");
		assert.equal(agent.calls.length, 0);
	}
	{
		const { agent, service } = setup();
		const content = snapshot();
		content.messages[0]!.attachments = [{ type: "image", url: null, description: null }];
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.equal(agent.calls.length, 0);
	}
	for (const attachments of [
		[{ type: "video", url: null, description: null, media: null }],
		[{ type: "sticker", url: null, description: null, media: null }],
		[{ type: "gif", url: null, description: null, media: null }],
		[{ type: "file" }],
	]) {
		const { agent, service } = setup();
		const content = snapshot();
		content.messages[0]!.attachments = attachments as never;
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.equal(agent.calls.length, 0);
	}
});

test("readable photos trigger the model, including photo-only latest messages", () => {
	const media = { mime: "image/jpeg" as const, data: "AAAA", width: 4, height: 4 };
	{
		const { agent, service } = setup();
		const content = snapshot("r1", "");
		content.messages[0]!.attachments = [
			{ type: "image", url: "https://example.test/photo", description: null, media: null },
		];
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "thinking");
		assert.equal(agent.calls.length, 1);
	}
	{
		const { agent, service } = setup();
		const content = snapshot("r1", "What do you think?");
		content.messages[0]!.attachments = [
			{ type: "image", url: "https://example.test/one", description: null, media: null },
			{ type: "image", url: null, description: null, media },
		];
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "thinking");
		assert.equal(agent.calls.length, 1);
	}
});

test("readable GIFs, stickers, and framed videos trigger the model, files do not", () => {
	const media = { mime: "image/jpeg" as const, data: "AAAA", width: 4, height: 4 };
	for (const attachments of [
		[{ type: "gif", url: "https://example.test/clip", description: null, media: null }],
		[{ type: "sticker", url: "https://example.test/sticker", description: null, media: null }],
		[{ type: "gif", url: null, description: null, media }],
		[{ type: "sticker", url: null, description: null, media }],
		[{ type: "video", url: null, description: null, media }],
		[{ type: "video", url: "https://example.test/clip.mp4", description: null, media: null }],
	]) {
		const { agent, service } = setup();
		const content = snapshot("r1", "");
		content.messages[0]!.attachments = attachments as never;
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "thinking");
		assert.equal(agent.calls.length, 1);
	}
	for (const attachments of [[{ type: "file" }], [{ type: "video", url: null, description: null, media: null }]]) {
		const { agent, service } = setup();
		const content = snapshot("r1", "See this");
		content.messages[0]!.attachments = attachments as never;
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.equal(agent.calls.length, 0);
	}
});

test("unreadable photos, other media, and quotes still pause for the user", () => {
	const media = { mime: "image/jpeg" as const, data: "AAAA", width: 4, height: 4 };
	const photo = { type: "image" as const, url: "https://example.test/photo", description: null, media: null };
	const cases: ConversationSnapshot["messages"][number][] = [
		// Bytes beyond reach stay presence-only.
		{
			...snapshot("r1", "See this").messages[0]!,
			attachments: [{ type: "image", url: null, description: null, media: null }],
		},
		{
			...snapshot("r1", "See this").messages[0]!,
			attachments: [{ type: "image", url: "http://example.test/photo", description: null, media: null }],
		},
		// Only photos forward bytes.
		{ ...snapshot("r1", "See this").messages[0]!, attachments: [{ type: "gif", url: null, description: null }] },
		{
			...snapshot("r1", "See this").messages[0]!,
			attachments: [photo, { type: "sticker", url: null, description: null }],
		},
		// Quote bytes stay client-side, so any quoted attachment pauses.
		{
			...snapshot("r1", "Nice").messages[0]!,
			attachments: [photo],
			replyTo: { text: "Original", context: "Reply", attachments: [photo] },
		},
	];
	for (const latest of cases) {
		const { agent, service } = setup();
		const content = { ...snapshot("r1"), messages: [latest] };
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.equal(agent.calls.length, 0);
	}
	// The fifth photo in one message falls past the snapshot cap.
	{
		const { agent, service } = setup();
		const local = { type: "image" as const, url: null, description: null, media };
		const content = snapshot("r1", "All five");
		content.messages[0]!.attachments = [local, local, local, local, local];
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.equal(agent.calls.length, 0);
	}
});

test("a quoted photo pauses with a specific message", () => {
	const photo = { type: "image" as const, url: "https://example.test/photo", description: null, media: null };
	{
		const { agent, service } = setup();
		const content = snapshot("r1", "What word is on this?");
		content.messages[0]!.replyTo = { text: null, context: null, attachments: [] };
		content.messages[0]!.attachments = [{ type: "video", url: null, description: null, media: null }];
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.deepEqual(result.detail, { code: "latest_unreadable" });
		assert.equal(agent.calls.length, 0);
	}
	{
		const { agent, service } = setup();
		const content = snapshot("r1", "What word is on this?");
		content.messages[0]!.replyTo = { text: "Original", context: "Reply", attachments: [photo] };
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.deepEqual(result.detail, { code: "latest_quotes_image" });
		assert.equal(agent.calls.length, 0);
	}
	{
		const { agent, service } = setup();
		const content = snapshot("r1", "Funny, right?");
		content.messages[0]!.replyTo = {
			text: null,
			context: "Reply",
			attachments: [{ type: "gif", url: null, description: null, media: null }],
		};
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.deepEqual(result.detail, { code: "latest_quotes_media" });
		assert.equal(agent.calls.length, 0);
	}
});

test("a re-encoded photo at the same revision does not pause verification", async () => {
	const { agent, service } = setup();
	const first = snapshot("r1", "See this");
	first.messages[0]!.attachments = [
		{ type: "image", url: null, description: null, media: { mime: "image/jpeg", data: "AAAA", width: 4, height: 4 } },
	];
	service.start("owner", "Arrange a meeting", first);
	agent.calls[0]!.resolve({ action: "wait" });
	await Promise.resolve();
	const second = snapshot("r1", "See this");
	second.messages[0]!.attachments = [
		{ type: "image", url: null, description: null, media: { mime: "image/jpeg", data: "BBBB", width: 4, height: 4 } },
	];
	const result = service.sync("owner", second);
	assert.equal(result.task?.status, "waiting");
});

test("an unsent latest message, including an unsent group event, does not trigger the model", () => {
	{
		const { agent, service } = setup();
		const content = snapshot("r1", "");
		content.messages[0]!.unsent = true;
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.deepEqual(result.detail!, { code: "latest_unsent_check_conversation" });
		assert.equal(agent.calls.length, 0);
	}
	{
		const { agent, service } = setup();
		const content = snapshot("r1", "Can we meet?");
		content.messages.push({ ...content.messages[0]!, id: "node-2", text: "", direction: "system", unsent: true });
		const result = service.start("owner", "Arrange a meeting", content);
		assert.equal(result.status, "needs_user");
		assert.equal(agent.calls.length, 0);
	}
});

test("known incoming text can be considered with incomplete older history", async () => {
	const { agent, service } = setup();
	const current = snapshot("r1", "Does Tuesday work?");
	const older: ConversationMessage = {
		id: "older",
		text: "See this",
		direction: "unknown",
		attachments: [{ type: "image", url: null, description: null }],
		replyTo: { text: null, context: null, attachments: [] },
		reactions: [],
		unsent: false,
	};
	const withHistory = { ...current, messages: [older, ...current.messages] };
	const task = service.start("owner", "Arrange a meeting", withHistory);
	assert.equal(task.status, "thinking");
	assert.deepEqual(agent.calls[0]!.snapshot.messages[0], older);
	agent.calls[0]!.resolve({ action: "ask", text: "Is the earlier photo relevant to Tuesday?" });
	await Promise.resolve();
	const result = service.sync("owner", withHistory);
	assert.equal(result.task?.status, "needs_user");
	assert.deepEqual(result.task?.detail, { code: "agent_message", text: "Is the earlier photo relevant to Tuesday?" });
	assert.equal(result.command, null);
});

test("takeover ignores a late model response", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	service.control("owner", task.id, "take-over");
	await resolveReply(agent);
	const result = service.sync("owner", snapshot());
	assert.equal(result.task?.status, "taken_over");
	assert.equal(result.command, null);
});

test("model decisions asking the user, waiting and finishing do not schedule a reply", async () => {
	for (const decision of [
		{ action: "wait" } as const,
		{ action: "ask", text: "Is Thursday available?" } as const,
		{ action: "finish", text: "Meeting agreed." } as const,
	]) {
		const { agent, service } = setup();
		service.start("owner", "Arrange a meeting", snapshot());
		agent.calls[0]!.resolve(decision);
		await Promise.resolve();
		const state = service.sync("owner", snapshot());
		assert.equal(state.command, null);
		assert.equal(
			state.task?.status,
			decision.action === "ask" ? "needs_user" : decision.action === "finish" ? "completed" : "waiting",
		);
	}
});

test("control characters are rejected in replies but allowed in the user's goal", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting\nAvoid Friday.", snapshot());
	await resolveReply(agent);
	service.control("owner", task.id, "edit");
	assert.throws(() => service.control("owner", task.id, "save-edit", "First line\nSecond line"), /single line/);
	assert.equal(service.sync("owner", snapshot()).task?.status, "editing");
});

test("owned terminal tasks can be deleted, including their snapshot and conversation state", async () => {
	const { agent, service } = setup();
	const task = service.start("owner", "Arrange a meeting", snapshot());
	assert.throws(() => service.clear("owner", task.id));
	service.control("owner", task.id, "take-over");
	assert.throws(() => service.clear("other", task.id));
	service.clear("owner", task.id);
	assert.equal(service.sync("owner", snapshot()).task, null);
	await resolveReply(agent);
	assert.equal(service.sync("owner", snapshot()).task, null);
});

test("system events remain context, invalidate pending replies, and do not hide unknown senders", async () => {
	const { agent, service } = setup();
	const initial = snapshot();
	service.start("owner", "Arrange a meeting", initial);
	await resolveReply(agent);
	const event: ConversationMessage = {
		id: "event",
		text: "Group renamed",
		direction: "system",
		replyTo: null,
		attachments: [],
		reactions: [],
		unsent: false,
	};
	const changed = { ...initial, revision: "r2", messages: [...initial.messages, event] };
	assert.equal(service.sync("owner", changed).task?.pendingReply, null);
	assert.equal(agent.calls.length, 2);
	assert.equal(agent.calls[1]!.snapshot.messages.at(-1)?.direction, "system");
	const unknown = {
		...snapshot("r3", "Who sent this?", "unknown"),
		messages: [...snapshot("r3", "Who sent this?", "unknown").messages, event],
	};
	assert.equal(service.sync("owner", unknown).task?.status, "needs_user");
	assert.equal(agent.calls.length, 2);
});

for (const empty of [false, true]) {
	test(`task start can initiate in ${empty ? "an empty chat" : "a chat with an outgoing last message"}`, async () => {
		const { agent, service, advance } = setup();
		const current = snapshot("r1", "Thanks for yesterday!", "outgoing");
		if (empty) current.messages = [];
		service.start("owner", "Ask whether Thursday works for dinner", current);
		assert.equal(agent.calls.length, 1);
		assert.equal(agent.calls[0]!.reason, "task_started");
		service.sync("owner", current);
		assert.equal(agent.calls.length, 1);
		await resolveReply(agent, 0, "Would Thursday evening work for dinner?");
		assert.equal(service.sync("owner", current).task?.pendingReply?.sendAt, 11_000);
		advance(9_999);
		assert.equal(service.sync("owner", current).command, null);
		advance(1);
		const command = service.sync("owner", current).command!;
		assert.ok(command);
		assert.equal(service.sync("owner", current).command, null);
		assert.equal(service.authorize("owner", command.commandId, "wrong-chat", current.revision), false);
		assert.equal(service.authorize("owner", command.commandId, current.chatId, current.revision), true);
		assert.equal(service.authorize("owner", command.commandId, current.chatId, current.revision), false);
		service.report("owner", command.commandId, "sent");
		assert.equal(agent.calls.length, 2);
		assert.equal(agent.calls[1]!.reason, "reply_sent");
		agent.calls[1]!.resolve({ action: "wait" });
		await Promise.resolve();
		assert.equal(service.sync("owner", current).command, null);
		assert.equal(agent.calls.length, 2);
	});
}

test("a sender display rename at the same revision does not pause verification", () => {
	const { service } = setup();
	const named = (sender: string | null) => {
		const renamed = snapshot();
		renamed.messages[0] = { ...renamed.messages[0]!, sender };
		return renamed;
	};
	service.start("owner", "Arrange a meeting", named("Mikołaj Gaweł"));
	const { task } = service.sync("owner", named("Mikołaj"));
	assert.notEqual(task?.status, "paused");
	assert.ok(task?.detail?.code !== "conversation_unverifiable");
	assert.ok(task?.detail?.code !== "conversation_unverifiable_send_uncertain");
});
