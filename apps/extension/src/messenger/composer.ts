import { isVisible } from "./dom-queries";

export function getComposer(main: HTMLElement): HTMLElement | null {
	const editors = [...main.querySelectorAll<HTMLElement>('[contenteditable="true"][role="textbox"]')].filter(isVisible);
	if (editors.length !== 1) return null;
	const editor = editors[0]!;
	const label = (editor.getAttribute("aria-label") ?? "").trim();
	const recognizedLabel =
		/^(?:message|message\.\.\.|message…|write a message|type a message|aa|wiadomość|napisz wiadomość|napisz wiadomość\.\.\.|napisz wiadomość…)$/i.test(
			label,
		);
	if (!recognizedLabel && editor.getAttribute("data-lexical-editor") !== "true") return null;
	if (editor.getAttribute("aria-disabled") === "true") return null;
	return editor;
}

export function hasUnsupportedDraft(main: HTMLElement, editor: HTMLElement): boolean {
	if (editor.querySelector('img, video, audio, canvas, input, [contenteditable="false"]')) return true;
	return [...main.querySelectorAll<HTMLElement>('button[aria-label], [role="button"][aria-label]')].some(
		(button) =>
			isVisible(button) &&
			/^(?:remove|delete|cancel) (?:attachment|photo|image|file|reply)|^(?:usuń|anuluj) (?:załącznik|zdjęcie|plik|odpowiedź)/i.test(
				button.getAttribute("aria-label")?.trim() ?? "",
			),
	);
}

// The paper-plane path is the observed Messenger send icon. Unlike its title,
// the vector is shared across locales. Match its shape only inside the active
// composer's region; a Like, attachment, or message-toolbar button cannot send.
const sendIconPath =
	"M16.6915026,12.4744748 L3.50612381,13.2599618 C3.19218622,13.2599618 3.03521743,13.4170592 3.03521743,13.5741566";
export function getSendButton(main: HTMLElement): HTMLElement | null {
	const editor = getComposer(main);
	const region = editor?.closest<HTMLElement>('[role="region"]');
	if (!region || !main.contains(region) || region.querySelector('[data-scope="messages_table"]')) return null;
	const buttons = [...region.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(
		(button) =>
			isVisible(button) &&
			[...button.querySelectorAll('svg[viewBox="0 0 24 24"] path')].some((path) =>
				(path.getAttribute("d") ?? "").replace(/\s+/g, "").startsWith(sendIconPath.replace(/\s+/g, "")),
			),
	);
	if (buttons.length !== 1) return null;
	const button = buttons[0]!;
	if (button.getAttribute("aria-disabled") === "true" || button.hasAttribute("disabled")) return null;
	return button;
}

export function selectContents(editor: HTMLElement, collapse: boolean): boolean {
	const selection = window.getSelection();
	if (!selection) return false;
	const range = document.createRange();
	range.selectNodeContents(editor);
	if (collapse) range.collapse(false);
	selection.removeAllRanges();
	selection.addRange(range);
	return true;
}

// Lexical ignores execCommand (it fires no beforeinput) and reverts the native
// DOM edit. It accepts a beforeinput event instead, cancels it, and commits its
// own DOM update after dispatch returns. Report whether Lexical took the edit.
export function editComposer(editor: HTMLElement, inputType: string, data: string | null = null): boolean {
	const event = new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true, composed: true });
	return !editor.dispatchEvent(event);
}

// Wait on DOM mutations rather than timers, which hidden tabs throttle. The
// timeout only bounds a composer that never reaches the expected state.
export function waitForComposer(ready: () => boolean): Promise<boolean> {
	return new Promise((resolve) => {
		if (ready()) return resolve(true);
		let done = false;
		const finish = (result: boolean) => {
			if (done) return;
			done = true;
			observer.disconnect();
			clearTimeout(timeout);
			resolve(result);
		};
		const observer = new MutationObserver(() => {
			if (ready()) finish(true);
		});
		observer.observe(document.body, { childList: true, characterData: true, attributes: true, subtree: true });
		const timeout = setTimeout(() => finish(ready()), 2_000);
	});
}
