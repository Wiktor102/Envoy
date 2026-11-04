import type { MessageAttachment } from "@envoy/contracts";
import { hasGifChrome, isAnimatedPreview, isGifButton, isGifLabel } from "./animated-preview";
import { isMessengerPhotoLink } from "./dom-queries";

// Media words in Messenger-supplied labels, EN and PL. The quote-preview
// check here uses the list without "gif", which isGifLabel handles; the
// reader's check in message-guards adds it.
export const ATTACHMENT_WORDS =
	"sticker|voice(?: message)?|audio(?: message)?|video|file attachment|naklejka|wiadomość głosowa|plik";

const QUOTED_ATTACHMENT_WORD = new RegExp(`(?:^|\\s)(?:${ATTACHMENT_WORDS})(?:$|[\\s:.,])`, "i");

function bareAttachment(type: "image" | "gif" | "video" | "sticker", url: string | null): MessageAttachment {
	return { type, url, description: null, media: null };
}

// A GIF renders as a photo link whose image alt names the format. Links sent
// through GIPHY also carry a caption naming the service, while an uploaded
// GIF renders the same link with a descriptive alt (e.g. "Obraz GIF") and no
// caption. One observed GIPHY shape carries neither: the render alt holds tag
// text with no format word, beside an empty-alt static image. The service
// chrome classifies that shape, the same check quote previews use. Observed
// photo links render their images with an empty alt and no chrome. Animated
// previews carry a play glyph instead.
export function isGifLink(viewer: HTMLElement): boolean {
	if (!viewer.matches("a[href]") || !isMessengerPhotoLink(viewer as HTMLAnchorElement)) return false;
	const image = gifLinkImage(viewer);
	if (image !== null && isGifLabel(image.getAttribute("alt") ?? "")) return true;
	return hasGifChrome(viewer);
}

// A GIF link can render several images, e.g. a static preview beside the
// animated render. Prefer the image whose alt names the format, then any
// labeled image over an empty-alt one, so the classification and the
// forwarded URL never depend on DOM order.
export function gifLinkImage(viewer: HTMLElement): HTMLImageElement | null {
	const images = [...viewer.querySelectorAll("img")];
	return (
		images.find((image) => isGifLabel(image.getAttribute("alt") ?? "")) ??
		images.find((image) => image.getAttribute("alt")?.trim()) ??
		images[0] ??
		null
	);
}

export function isGifViewer(viewer: HTMLElement): boolean {
	return isAnimatedPreview(viewer) || isGifButton(viewer) || isGifLink(viewer);
}

// Quote previews stay type-only: their bytes never reach the backend, but
// capturing their kind keeps the pause specific instead of failing the read.
// Observed shapes: photo previews (alt naming the kind), GIF previews
// (gif-labeled, or a disabled open-GIF link with a GIPHY caption and
// empty-alt images), video previews (one empty-alt https thumbnail, no
// <video>), sticker previews (one https image whose descriptive alt omits
// the word sticker), and file previews (generic text, no image at all).
// Voice-labeled and sticker-worded images keep tripping the fail-closed
// reader: detection stays narrow on purpose.
export function getQuotedAttachments(button: Element): { element: HTMLImageElement; attachment: MessageAttachment }[] {
	const images = [...button.querySelectorAll<HTMLImageElement>("img")].filter(
		(image) => !image.closest('[dir="auto"], [aria-hidden="true"]'),
	);
	const gifChrome = hasGifChrome(button);
	const quoted: { element: HTMLImageElement; attachment: MessageAttachment }[] = [];
	for (const image of images) {
		const label = quotedImageLabel(image);
		// Anything the reader cannot name stays unsupported.
		if (QUOTED_ATTACHMENT_WORD.test(label)) continue;
		if (isGifLabel(label)) {
			quoted.push({ element: image, attachment: bareAttachment("gif", null) });
			continue;
		}
		if (/photo|image|zdjęci|obraz/i.test(label)) {
			quoted.push({ element: image, attachment: imageAttachment(image) });
			continue;
		}
		const src = imageSource(image);
		if (!src.trim()) continue;
		const url = renderedSourceUrl(image);
		if (!image.getAttribute("alt")?.trim()) {
			if (gifChrome) {
				quoted.push({ element: image, attachment: bareAttachment("gif", url) });
			} else if (url && images.length === 1 && !src.startsWith("blob:")) {
				quoted.push({ element: image, attachment: bareAttachment("video", url) });
			}
			continue;
		}
		quoted.push({ element: image, attachment: bareAttachment("sticker", url) });
	}
	return quoted;
}

export function getQuotedImages(button: Element): HTMLImageElement[] {
	return getQuotedAttachments(button).map(({ element }) => element);
}

function quotedImageLabel(image: HTMLImageElement): string {
	return `${image.alt} ${image.getAttribute("aria-label") ?? ""}`;
}

// A viewer link identifies the attachment; the image element supplies the
// direct URL when one is rendered. No network request is needed to read it.
function remoteSourceUrl(source: string | null | undefined): string | null {
	if (!source?.trim()) return null;
	try {
		const url = new URL(source, location.href);
		if (url.protocol === "http:" || url.protocol === "https:") return url.href;
	} catch {
		// Ignore malformed or unavailable sources.
	}
	return null;
}

function renderedSourceUrl(element: HTMLImageElement | HTMLVideoElement | null): string | null {
	return remoteSourceUrl(element?.currentSrc) ?? remoteSourceUrl(element?.getAttribute("src"));
}

export function videoSource(viewer: HTMLElement): HTMLVideoElement | null {
	return viewer.matches("video") ? (viewer as HTMLVideoElement) : viewer.querySelector<HTMLVideoElement>("video");
}

export function videoAttachment(viewer: HTMLElement): MessageAttachment {
	// An https source identifies the clip for a future fetch; only a captured
	// poster frame forwards bytes. Blob sources are transient and never leave.
	return bareAttachment("video", renderedSourceUrl(videoSource(viewer)));
}

export function stickerBackgroundSource(graphic: HTMLElement): string {
	return (
		graphic
			.getAttribute("style")
			?.match(/background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/i)?.[1]
			?.trim() ?? ""
	);
}

export function stickerAttachment(graphic: HTMLElement): MessageAttachment {
	// An https background identifies the graphic for the backend fetch. Blob
	// backgrounds inline through canvas in inline-media; the URL itself stays out of the
	// revision because CSS URLs can rotate across reloads.
	return bareAttachment("sticker", remoteSourceUrl(stickerBackgroundSource(graphic)));
}

export function gifAttachment(viewer: HTMLElement): MessageAttachment {
	// An https render identifies the GIF for the backend fetch. Local renders
	// inline in inline-media; animated previews forward their opening frame as a still.
	// Multi-image links resolve to the GIF render, never DOM order.
	return bareAttachment("gif", renderedSourceUrl(gifLinkImage(viewer) ?? viewer.querySelector("img")));
}

export function fileAttachment(): MessageAttachment {
	// The download href never leaves the extension. The model only learns
	// that a file is present, and the task pauses like any unreadable media.
	return { type: "file" };
}

export function imageSource(image: HTMLImageElement | null): string {
	return image?.currentSrc || image?.getAttribute("src") || "";
}

export function imageAttachment(image: HTMLImageElement | null): MessageAttachment {
	return bareAttachment("image", renderedSourceUrl(image));
}

export function isRemoteSource(source: string): boolean {
	return remoteSourceUrl(source) !== null;
}
