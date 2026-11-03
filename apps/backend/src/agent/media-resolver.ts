import sharp from "sharp";
import type { InlineImageMedia, MessageAttachment } from "@envoy/contracts";
import { MAX_IMAGE_SIDE } from "@envoy/contracts";
import { debugMedia } from "./diagnostics.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_FETCH_BYTES = 8_000_000;
const MAX_REDIRECTS = 3;

export type ResolvedMedia = { block: "image"; dataUrl: string } | { block: "video"; dataUrl: string } | null;

export async function resolveMedia(attachment: MessageAttachment, signal?: AbortSignal): Promise<ResolvedMedia> {
	const origin = attachment.type === "file" ? "none" : attachment.media ? "inline" : "url";
	const resolved = await resolveMediaInner(attachment, signal);
	debugMedia(`media ${attachment.type} ${origin} -> ${resolved ? `${resolved.block} block` : "presence-only"}`);
	return resolved;
}

function cappedInlineBytes(data: string): Buffer | null {
	const bytes = Buffer.from(data, "base64");
	return bytes.length && bytes.length <= MAX_FETCH_BYTES ? bytes : null;
}

// Inline bytes always resolve to a still: video arrives as a captured poster
// frame, other media as the render itself.
async function inlineImageBlock(media: InlineImageMedia): Promise<ResolvedMedia> {
	const bytes = cappedInlineBytes(media.data);
	if (!bytes) return null;
	const dataUrl = await imageDataUrl(bytes, media.mime);
	return dataUrl ? { block: "image", dataUrl } : null;
}

async function resolveMediaInner(attachment: MessageAttachment, signal?: AbortSignal): Promise<ResolvedMedia> {
	try {
		switch (attachment.type) {
			case "image":
			case "gif":
			case "sticker": {
				if (attachment.media) return inlineImageBlock(attachment.media);
				if (attachment.url) {
					const fetched = await fetchMediaBytes(attachment.url, signal, "image/");
					if (!fetched) return null;
					const dataUrl = await imageDataUrl(fetched.bytes, null);
					return dataUrl ? { block: "image", dataUrl } : null;
				}
				break;
			}
			case "video": {
				if (attachment.media) return inlineImageBlock(attachment.media);
				if (attachment.url) {
					const fetched = await fetchMediaBytes(attachment.url, signal, "video/");
					if (!fetched) return null;
					return {
						block: "video",
						dataUrl: `data:${fetched.contentType};base64,${fetched.bytes.toString("base64")}`,
					};
				}
				break;
			}
			case "file":
				break;
		}
	} catch {
		// Unreadable bytes stay presence-only.
	}
	return null;
}

// One megabyte of image bytes. Renders past it re-encode to a still instead
// of going out untouched.
const MAX_IMAGE_BYTES = 1_000_000;

async function readMetadata(bytes: Buffer) {
	try {
		return await sharp(bytes).metadata();
	} catch {
		return null;
	}
}

async function encodeStill(bytes: Buffer): Promise<string | null> {
	try {
		const resized = await sharp(bytes)
			.resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: "inside", withoutEnlargement: true })
			.jpeg({ quality: 85 })
			.toBuffer();
		return `data:image/jpeg;base64,${resized.toString("base64")}`;
	} catch {
		return null;
	}
}

function fitsInline(width: number, height: number, length: number): boolean {
	return width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE && length <= MAX_IMAGE_BYTES;
}

// Stills only: video arrives as a captured poster frame, and bytes already
// within caps pass through untouched instead of re-encoding.
async function imageDataUrl(bytes: Buffer, mime: string | null): Promise<string | null> {
	const meta = await readMetadata(bytes);
	if (!meta) return null;
	const formats: Record<string, string> = {
		jpeg: "image/jpeg",
		png: "image/png",
		webp: "image/webp",
		gif: "image/gif",
	};
	const format = meta.format ? formats[meta.format] : undefined;
	if (!format || !meta.width || !meta.height) return null;
	if (mime && mime !== format) return null;
	// Small renders pass through untouched, animation included. Large ones
	// re-encode to a still: oversized blocks have no passing record, and a
	// first-frame still describes where a rejected block produced nothing.
	if (fitsInline(meta.width, meta.height, bytes.length)) {
		return `data:${format};base64,${bytes.toString("base64")}`;
	}
	return encodeStill(bytes);
}

function tryParseUrl(value: string, base?: string): URL | null {
	try {
		return new URL(value, base);
	} catch {
		return null;
	}
}

// Fetch one render at evaluation time. Chat URLs need no cookies and may die
// young, so anything unexpected falls back to presence-only.
async function fetchMediaBytes(
	url: string,
	signal: AbortSignal | undefined,
	contentPrefix: "image/" | "video/",
): Promise<{ bytes: Buffer; contentType: string } | null> {
	let current = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const parsed = tryParseUrl(current);
		if (!parsed || parsed.protocol !== "https:") return null;
		const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
		let response: Response;
		try {
			response = await fetch(current, {
				redirect: "manual",
				credentials: "omit",
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
		} catch {
			return null;
		}
		if (response.status >= 300 && response.status < 400) {
			const next = response.headers.get("location");
			const redirect = next ? tryParseUrl(next, current) : null;
			if (!redirect) return null;
			current = redirect.href;
			continue;
		}
		const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
		if (!response.ok || !contentType.startsWith(contentPrefix)) {
			debugMedia(`fetch rejected: status ${response.status} type ${contentType || "none"}`);
			return null;
		}
		try {
			const reader = response.body?.getReader();
			if (!reader) return null;
			const chunks: Uint8Array[] = [];
			let size = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_FETCH_BYTES) {
					await reader.cancel();
					return null;
				}
				chunks.push(value);
			}
			const bytes = Buffer.concat(chunks);
			debugMedia(`fetch ${contentType} ${bytes.length}B`);
			return { bytes, contentType };
		} catch {
			return null;
		}
	}
	return null;
}
