import type { ConversationSnapshot, InlineImageMedia, InlineImageMime } from "@envoy/contracts";
import { INLINE_IMAGE_MIMES, MAX_IMAGE_SIDE, MAX_INLINE_MEDIA_CHARS, MAX_SNAPSHOT_IMAGES } from "@envoy/contracts";
import { gifLinkImage, imageSource, isGifViewer, isRemoteSource, stickerBackgroundSource, videoSource } from "./attachments";
import type { RenderedMessage } from "./rendered-message";

const MEDIA_LOAD_TIMEOUT_MS = 5000;
const MEDIA_JPEG_QUALITY = 0.85;
// Raw sources decode before the byte cap applies: downscaling is what earns
// compliance. This only bounces pathological inputs before decoding them.
const MAX_INLINE_SOURCE_CHARS = 12_000_000;

// Decoded media bytes keyed by element. Polling re-reads the same nodes, so
// the cache avoids re-decoding every snapshot. Entries die with their nodes.
const mediaCache = new WeakMap<object, { source: string; media: InlineImageMedia | null }>();

function parseInlineData(source: string): { mime: string; data: string } | null {
	const match = source.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/);
	if (!match || !match[2] || match[2].length % 4 !== 0) return null;
	return { mime: match[1]!, data: match[2]! };
}

function loadImage(source: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		const timer = setTimeout(() => reject(new Error("timeout")), MEDIA_LOAD_TIMEOUT_MS);
		image.onload = () => {
			clearTimeout(timer);
			resolve(image);
		};
		image.onerror = () => {
			clearTimeout(timer);
			reject(new Error("unreadable"));
		};
		image.src = source;
	});
}

// Decode a local data: source, downscaling or re-encoding through canvas until
// it fits the caps. Anything unexpected stays presence-only.
async function decodeLocalMedia(source: string): Promise<InlineImageMedia | null> {
	const parsed = parseInlineData(source);
	if (!parsed || !INLINE_IMAGE_MIMES.includes(parsed.mime as InlineImageMime)) return null;
	if (parsed.data.length > MAX_INLINE_SOURCE_CHARS) return null;
	let loaded: HTMLImageElement;
	try {
		loaded = await loadImage(source);
	} catch {
		return null;
	}
	const width = loaded.naturalWidth;
	const height = loaded.naturalHeight;
	if (!width || !height) return null;
	if (width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE && parsed.data.length <= MAX_INLINE_MEDIA_CHARS) {
		return { mime: parsed.mime as InlineImageMime, data: parsed.data, width, height };
	}
	return encodeCanvasFrame(width, height, (context, targetWidth, targetHeight) => {
		context.drawImage(loaded, 0, 0, targetWidth, targetHeight);
	});
}

// Re-encode a rendered frame through canvas until it fits the caps. Used for
// blob: renders the backend cannot fetch (sticker backgrounds, animated GIF
// previews) and for video poster frames. A tainted canvas throws, so
// cross-origin renders without CORS approval stay presence-only.
function encodeCanvasFrame(
	width: number,
	height: number,
	paint: (context: CanvasRenderingContext2D, targetWidth: number, targetHeight: number) => void,
): InlineImageMedia | null {
	const scale = Math.min(1, MAX_IMAGE_SIDE / width, MAX_IMAGE_SIDE / height);
	const targetWidth = Math.max(1, Math.floor(width * scale));
	const targetHeight = Math.max(1, Math.floor(height * scale));
	try {
		const canvas = document.createElement("canvas");
		canvas.width = targetWidth;
		canvas.height = targetHeight;
		const context = canvas.getContext("2d");
		if (!context) return null;
		paint(context, targetWidth, targetHeight);
		const downscaled = parseInlineData(canvas.toDataURL("image/jpeg", MEDIA_JPEG_QUALITY));
		if (!downscaled || downscaled.mime !== "image/jpeg" || downscaled.data.length > MAX_INLINE_MEDIA_CHARS) return null;
		return { mime: "image/jpeg", data: downscaled.data, width: targetWidth, height: targetHeight };
	} catch {
		return null;
	}
}

// Decode a blob: render through an image element and canvas. Unlike data:
// sources there are no bytes to pass through, so every blob re-encodes as a
// still frame.
async function decodeBlobMedia(source: string): Promise<InlineImageMedia | null> {
	if (!source.startsWith("blob:")) return null;
	let loaded: HTMLImageElement;
	try {
		loaded = await loadImage(source);
	} catch {
		return null;
	}
	const width = loaded.naturalWidth;
	const height = loaded.naturalHeight;
	if (!width || !height) return null;
	return encodeCanvasFrame(width, height, (context, targetWidth, targetHeight) => {
		context.drawImage(loaded, 0, 0, targetWidth, targetHeight);
	});
}

function videoReady(video: HTMLVideoElement): Promise<void> {
	if (video.readyState >= 2) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("timeout"));
		}, MEDIA_LOAD_TIMEOUT_MS);
		const onData = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(new Error("unreadable"));
		};
		function cleanup() {
			clearTimeout(timer);
			video.removeEventListener("loadeddata", onData);
			video.removeEventListener("error", onError);
		}
		video.addEventListener("loadeddata", onData);
		video.addEventListener("error", onError);
	});
}

// Capture a video poster's current frame as a still. Blob clips decode
// same-origin; remote clips without CORS approval taint the canvas and stay
// presence-only, as does anything that never loads.
async function decodeVideoFrame(video: HTMLVideoElement): Promise<InlineImageMedia | null> {
	try {
		await videoReady(video);
	} catch {
		return null;
	}
	const width = video.videoWidth;
	const height = video.videoHeight;
	if (!width || !height) return null;
	return encodeCanvasFrame(width, height, (context, targetWidth, targetHeight) => {
		context.drawImage(video, 0, 0, targetWidth, targetHeight);
	});
}

async function cachedMedia(
	element: object,
	source: string,
	decode: () => Promise<InlineImageMedia | null>,
): Promise<InlineImageMedia | null> {
	const cached = mediaCache.get(element);
	if (cached && cached.source === source) return cached.media;
	const media = await decode();
	mediaCache.set(element, { source, media });
	return media;
}

function extractLocalMedia(image: HTMLImageElement): Promise<InlineImageMedia | null> {
	const source = imageSource(image);
	return cachedMedia(image, source, () => decodeLocalMedia(source));
}

function extractRasterMedia(element: object, source: string): Promise<InlineImageMedia | null> {
	return cachedMedia(element, source, () =>
		source.startsWith("blob:") ? decodeBlobMedia(source) : decodeLocalMedia(source),
	);
}

function extractVideoMedia(video: HTMLVideoElement, source: string): Promise<InlineImageMedia | null> {
	return cachedMedia(video, source, () => decodeVideoFrame(video));
}

// Fill inline bytes for local media sources, newest first within the shared
// snapshot cap. Remote photo, GIF, and sticker sources need nothing: the
// backend fetches them itself. Remote video sources stay presence-only: the
// backend cannot make stills from video bytes.
export async function attachInlineMedia(
	rendered: RenderedMessage[],
	messages: ConversationSnapshot["messages"],
): Promise<void> {
	type Candidate =
		| { message: number; position: number; kind: "image" | "gif"; image: HTMLImageElement }
		| { message: number; position: number; kind: "sticker"; element: HTMLElement; source: string }
		| { message: number; position: number; kind: "video"; video: HTMLVideoElement; source: string };
	const candidates: Candidate[] = [];
	rendered.forEach(({ images, videos, stickers }, message) => {
		// Positions mirror readMessages: images, then videos, then stickers.
		let position = 0;
		for (const viewer of images) {
			const slot = position++;
			const gif = isGifViewer(viewer);
			const image = gif ? (gifLinkImage(viewer) ?? viewer.querySelector("img")) : viewer.querySelector("img");
			if (!image) continue;
			const source = imageSource(image);
			// Animated GIF buttons and previews inline their local renders
			// below; only photos skipped GIF handling before.
			if (!isRemoteSource(source) && !parseInlineData(source) && !source.startsWith("blob:")) continue;
			candidates.push({ message, position: slot, kind: gif ? "gif" : "image", image });
		}
		for (const viewer of videos) {
			const slot = position++;
			const video = videoSource(viewer);
			if (!video) continue;
			const source = video.currentSrc || video.getAttribute("src") || "";
			if (!source || isRemoteSource(source)) continue;
			candidates.push({ message, position: slot, kind: "video", video, source });
		}
		for (const sticker of stickers) {
			const slot = position++;
			const source = stickerBackgroundSource(sticker);
			if (!source || isRemoteSource(source)) continue;
			candidates.push({ message, position: slot, kind: "sticker", element: sticker, source });
		}
	});
	await Promise.all(
		candidates.slice(-MAX_SNAPSHOT_IMAGES).map(async (candidate) => {
			let media: InlineImageMedia | null = null;
			if (candidate.kind === "image" || candidate.kind === "gif") {
				if (isRemoteSource(imageSource(candidate.image))) return;
				media =
					candidate.kind === "image"
						? await extractLocalMedia(candidate.image)
						: await extractRasterMedia(candidate.image, imageSource(candidate.image));
			} else if (candidate.kind === "sticker") {
				media = await extractRasterMedia(candidate.element, candidate.source);
			} else if (candidate.kind === "video") {
				media = await extractVideoMedia(candidate.video, candidate.source);
			}
			const slot = messages[candidate.message]?.attachments[candidate.position];
			if (media && slot && slot.type !== "file") slot.media = media;
		}),
	);
}
