import type OpenAI from "openai";
import type { AgentChatMessage, ConversationSnapshot } from "@envoy/contracts";
import { forwardableMediaSlots } from "@envoy/contracts";
import { resolveMedia } from "./media-resolver.js";

function imagePart(image: string) {
	return {
		type: "image_url",
		image_url: { url: image, detail: "auto" },
	} as const;
}

function videoPart(url: string) {
	return {
		type: "video_url",
		video_url: { url },
		// The SDK's chat types have no video part; the endpoint
		// may still accept it. A rejection falls back to
		// presence-only in run().
	} as unknown as OpenAI.ChatCompletionContentPart;
}

export function userMessage(payloadText: string, imageUrls: string[], videoUrls: string[]) {
	if (!imageUrls.length && !videoUrls.length) return { role: "user" as const, content: payloadText };
	return {
		role: "user" as const,
		content: [{ type: "text", text: payloadText } as const, ...imageUrls.map(imagePart), ...videoUrls.map(videoPart)],
	};
}

// Rebuild the payload with video clips presence-only after the endpoint
// rejects video blocks. Image blocks stay as resolved.
export function dropVideoIndexes(payload: string): string {
	const body = JSON.parse(payload) as {
		participants: unknown;
		conversation: { attachments: Record<string, unknown>[] }[];
	};
	return JSON.stringify({
		...body,
		conversation: body.conversation.map((entry) => ({
			...entry,
			attachments: entry.attachments.map((attachment) => {
				if (!("videoIndex" in attachment)) return attachment;
				const { videoIndex: _dropped, ...next } = attachment;
				return next;
			}),
		})),
	});
}

// Resolve the newest forwarded media to data URLs in document order. Every
// failure falls back to presence-only: the attachment keeps its bare type.
export async function collectMedia(
	conversation: ConversationSnapshot,
	signal?: AbortSignal,
): Promise<{ payload: string; images: string[]; videos: string[] }> {
	const slots = forwardableMediaSlots(conversation.messages);
	const resolved = await Promise.all(
		conversation.messages.map((message, index) =>
			Promise.all(
				message.attachments.map((attachment, position) =>
					slots[index]?.[position] ? resolveMedia(attachment, signal) : Promise.resolve(null),
				),
			),
		),
	);
	const images: string[] = [];
	const videos: string[] = [];
	const indexes = resolved.map((entries) =>
		entries.map((entry) => {
			if (!entry) return null;
			if (entry.block === "image") {
				images.push(entry.dataUrl);
				return { kind: "image", imageIndex: images.length - 1 } as const;
			}
			videos.push(entry.dataUrl);
			return { kind: "video", videoIndex: videos.length - 1 } as const;
		}),
	);
	const payload = JSON.stringify({
		// Unverified chat-header display strings, like conversation text.
		participants: [...conversation.participants],
		conversation: conversation.messages.map(
			({ direction, sender, text, replyTo, attachments, unsent, edited }, index) => ({
				direction,
				sender,
				text,
				unsent,
				edited: edited ?? null,
				// Do not send attachment URLs; the agent inspects media through blocks.
				attachments: attachments.map((attachment, position) => {
					const ref = indexes[index]?.[position];
					if (ref?.kind === "image") return { type: attachment.type, imageIndex: ref.imageIndex };
					if (ref?.kind === "video") return { type: attachment.type, videoIndex: ref.videoIndex };
					return { type: attachment.type };
				}),
				replyTo: replyTo
					? {
							text: replyTo.text,
							context: replyTo.context,
							attachments: replyTo.attachments.map(({ type }) => ({ type })),
						}
					: null,
			}),
		),
	});
	return { payload, images, videos };
}

export function formatAgentChat(chat: readonly AgentChatMessage[]): string {
	if (!chat.length) return "";
	const lines = chat.map(({ role, text, body }) => (body ? { role, text, body } : { role, text }));
	return `\nConversation with the user: ${JSON.stringify(lines)}`;
}
