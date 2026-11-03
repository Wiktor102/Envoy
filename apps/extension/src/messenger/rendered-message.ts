import { messageBoundary } from "./dom-queries";

export interface RenderedMessage {
	element: HTMLElement;
	boundary: Element | null;
	images: HTMLElement[];
	videos: HTMLElement[];
	stickers: HTMLElement[];
	files: HTMLElement[];
	unsent: boolean;
	standaloneLike?: boolean;
}

export function renderedMessage(
	element: HTMLElement,
	fields: Partial<Pick<RenderedMessage, "unsent" | "standaloneLike">> = {},
): RenderedMessage {
	return {
		element,
		boundary: messageBoundary(element),
		images: [],
		videos: [],
		stickers: [],
		files: [],
		unsent: false,
		...fields,
	};
}

export function messengerMessageId(message: RenderedMessage | undefined): string {
	return message?.boundary?.getAttribute("data-message-id") ?? "";
}
