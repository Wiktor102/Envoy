import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationMessage, MessageAttachment } from "../src/index.js";
import {
	attachmentIdentity,
	forwardableImageSlots,
	forwardableMediaSlots,
	MAX_SNAPSHOT_IMAGES,
	messageContent,
} from "../src/index.js";

const media = { mime: "image/jpeg" as const, data: "AAAA", width: 4, height: 4 };

function message(attachments: MessageAttachment[]): ConversationMessage {
	return {
		id: "node",
		stableId: null,
		edited: false,
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
const remoteGif = (url: string | null = "https://example.test/clip"): MessageAttachment => ({
	type: "gif",
	url,
	description: null,
	media: null,
});
const remoteSticker = (url: string | null = "https://example.test/sticker"): MessageAttachment => ({
	type: "sticker",
	url,
	description: null,
	media: null,
});
const videoFrame = (): MessageAttachment => ({ type: "video", url: null, description: null, media });
const videoUrlOnly = (): MessageAttachment => ({
	type: "video",
	url: "https://example.test/clip.mp4",
	description: null,
	media: null,
});
const file = (): MessageAttachment => ({ type: "file" });

test("forwardable slots cover the newest images and skip the rest", () => {
	const messages = [
		message([remote(), remote()]),
		message([
			{ type: "video", url: null, description: null, media: null },
			remote(),
			{ type: "gif", url: null, description: null, media: null },
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

test("forwardable media slots cover video stills, GIFs, and stickers but never files", () => {
	const messages = [
		message([remote(), file()]),
		message([remoteGif(), remoteSticker(), videoFrame(), videoUrlOnly()]),
		message([remote(null)]),
	];
	assert.deepEqual(forwardableMediaSlots(messages), [
		[true, false],
		// Newest-first: the sticker, the framed video, and the GIF take three
		// of the four slots. A video URL alone never qualifies: the backend
		// cannot make stills from video bytes, so it stays presence-only.
		[true, true, true, false],
		[false],
	]);
});

test("forwardable media slots share one cap across every media type", () => {
	const messages = [message([remote(), remoteGif()]), message([remoteSticker(), videoFrame(), local()])];
	assert.deepEqual(forwardableMediaSlots(messages), [
		[false, true],
		[true, true, true],
	]);
});

test("attachment identity strips inline bytes but keeps the source", () => {
	assert.deepEqual(attachmentIdentity(local()), { type: "image", url: null, description: null, media: null });
	const url = remote();
	assert.equal(attachmentIdentity(url), url);
	assert.deepEqual(attachmentIdentity({ type: "sticker", url: null, description: null, media: null }), {
		type: "sticker",
		url: null,
		description: null,
		media: null,
	});
});

test("attachment identity drops sticker URLs and every inline frame", () => {
	// Sticker CSS URLs rotate across reloads and may be sensitive. The graphic
	// label in the DOM fingerprint identifies the sticker instead.
	assert.deepEqual(attachmentIdentity(remoteSticker()), {
		type: "sticker",
		url: null,
		description: null,
		media: null,
	});
	assert.deepEqual(attachmentIdentity(videoFrame()), { type: "video", url: null, description: null, media: null });
	assert.deepEqual(attachmentIdentity(remoteGif()), remoteGif());
	assert.deepEqual(attachmentIdentity(file()), file());
	assert.deepEqual(attachmentIdentity(videoUrlOnly()), videoUrlOnly());
});

test("message content drops the node ID, sender label, and inline bytes", () => {
	const content = messageContent({
		...message([local()]),
		id: "other-node",
		stableId: "stable-other",
		sender: "Alex",
		text: "Hi",
	});
	assert.deepEqual(content, messageContent({ ...message([local()]), text: "Hi" }));
	assert.deepEqual(content, {
		text: "Hi",
		direction: "incoming",
		replyTo: null,
		attachments: [{ type: "image", url: null, description: null, media: null }],
		reactions: [],
		unsent: false,
		edited: false,
	});
});
