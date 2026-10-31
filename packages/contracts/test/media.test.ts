import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationMessage, MessageAttachment } from "../src/index.js";
import { attachmentIdentity, forwardableImageSlots, MAX_SNAPSHOT_IMAGES } from "../src/index.js";

const media = { mime: "image/jpeg" as const, data: "AAAA", width: 4, height: 4 };

function message(attachments: MessageAttachment[]): ConversationMessage {
	return {
		id: "node",
		text: "",
		direction: "incoming",
		sender: null,
		replyTo: null,
		attachments,
		reactions: [],
		unsent: false,
	};
}

const remote = (url: string | null = "https://example.test/photo"): MessageAttachment => ({
	type: "image",
	url,
	description: null,
	media: null,
});
const local = (): MessageAttachment => ({ type: "image", url: null, description: null, media });

test("forwardable slots cover the newest images and skip the rest", () => {
	const messages = [
		message([remote(), remote()]),
		message([
			{ type: "video", url: null, description: null },
			remote(),
			{ type: "gif", url: null, description: null },
			local(),
		]),
		message([remote("http://example.test/plain"), remote(null)]),
	];
	assert.deepEqual(forwardableImageSlots(messages), [
		[true, true],
		[false, true, false, true],
		[false, false],
	]);
	assert.equal(MAX_SNAPSHOT_IMAGES, 4);
});

test("forwardable slots stop at the snapshot cap, oldest first", () => {
	const messages = [message([remote(), remote(), remote()]), message([remote(), remote(), remote()])];
	assert.deepEqual(forwardableImageSlots(messages), [
		[false, false, true],
		[true, true, true],
	]);
});

test("attachment identity strips inline bytes but keeps the source", () => {
	assert.deepEqual(attachmentIdentity(local()), { type: "image", url: null, description: null, media: null });
	const url = remote();
	assert.equal(attachmentIdentity(url), url);
	assert.deepEqual(attachmentIdentity({ type: "sticker", url: null, description: null }), {
		type: "sticker",
		url: null,
		description: null,
	});
});
