import type { ConversationSnapshot, SendReplyCommand, SendResult } from "@envoy/contracts";
import { editComposer, getComposer, getSendButton, hasUnsupportedDraft, selectContents, waitForComposer } from "./composer";
import { captureIsCurrent, type ConversationCapture, readCapturedConversation } from "./conversation-capture";
import { messengerMessageId } from "./rendered-message";
import { confirmSend } from "./send-confirmation";

export async function performSend(
	command: SendReplyCommand,
	authorize: () => Promise<boolean>,
	isCurrent: () => boolean,
): Promise<SendResult> {
	let capture: ConversationCapture;
	let before: ConversationSnapshot;
	try {
		({ capture, snapshot: before } = await readCapturedConversation());
	} catch {
		return "rejected";
	}
	if (before.chatId !== command.chatId || before.revision !== command.expectedRevision) return "rejected";
	try {
		if (!isCurrent()) return "rejected";
	} catch {
		return "rejected";
	}
	const editor = getComposer(capture.main);
	if (!editor || editor.textContent !== "" || hasUnsupportedDraft(capture.main, editor)) return "rejected";

	let ownEdit = false;
	let changedByUser = false;
	const input = () => {
		if (!ownEdit) changedByUser = true;
	};
	editor.addEventListener("input", input);
	const removeListener = () => editor.removeEventListener("input", input);
	const clearOurDraft = async (): Promise<boolean> => {
		// If the user changed or left the editor, keep the draft intact.
		if (changedByUser || !editor.isConnected || editor.textContent !== command.text || document.activeElement !== editor)
			return false;
		if (!selectContents(editor, false)) return false;
		ownEdit = true;
		try {
			// Leave a draft alone if Messenger will not accept an editing command.
			if (!editComposer(editor, "deleteContentBackward")) return false;
		} catch {
			return false;
		} finally {
			ownEdit = false;
		}
		await waitForComposer(() => editor.textContent === "");
		return !changedByUser && editor.isConnected && editor.textContent === "";
	};
	const stopBeforeDispatch = async (): Promise<SendResult> => {
		const safeToClear = !changedByUser && editor.isConnected && editor.textContent === command.text;
		const cleared = safeToClear && (await clearOurDraft());
		removeListener();
		// A changed or retained draft may have been sent manually. Do not assume a
		// failed Lexical deletion cleared our text without checking the composer.
		return cleared ? "rejected" : "uncertain";
	};

	try {
		if (!isCurrent() || !captureIsCurrent(capture)) {
			removeListener();
			return "rejected";
		}
		editor.focus();
		if (document.activeElement !== editor || editor.textContent !== "" || !selectContents(editor, true)) {
			removeListener();
			return "rejected";
		}
		if (
			!isCurrent() ||
			!captureIsCurrent(capture) ||
			getComposer(capture.main) !== editor ||
			editor.textContent !== ""
		) {
			removeListener();
			return "rejected";
		}
		ownEdit = true;
		let inserted: boolean;
		try {
			inserted = editComposer(editor, "insertText", command.text);
		} finally {
			ownEdit = false;
		}
		if (inserted) await waitForComposer(() => editor.textContent === command.text);
		if (!inserted || changedByUser || editor.textContent !== command.text || hasUnsupportedDraft(capture.main, editor)) {
			return stopBeforeDispatch();
		}

		// Messenger renders its send control a few task turns after the draft.
		await waitForComposer(() => getSendButton(capture.main) !== null);
		if (!(await authorize())) return stopBeforeDispatch();

		// No await is allowed between the final authorization, local check, and click.
		const button = getSendButton(capture.main);
		if (
			!button ||
			changedByUser ||
			getComposer(capture.main) !== editor ||
			editor.textContent !== command.text ||
			hasUnsupportedDraft(capture.main, editor) ||
			!captureIsCurrent(capture) ||
			!isCurrent() ||
			getComposer(capture.main) !== editor ||
			editor.textContent !== command.text ||
			hasUnsupportedDraft(capture.main, editor) ||
			getSendButton(capture.main) !== button ||
			!captureIsCurrent(capture)
		) {
			return stopBeforeDispatch();
		}
		removeListener();
		// Save values before the click: Messenger can remount bubbles or replace
		// optimistic IDs while confirming. An old server ID is never a new send.
		const previousMessageIds = new Set(capture.rendered.map(messengerMessageId).filter(Boolean));
		// A thrown click handler does not prove the message was not dispatched.
		try {
			button.click();
		} catch {
			return "uncertain";
		}
		try {
			return await confirmSend(before, command.text, previousMessageIds);
		} catch {
			return "uncertain";
		}
	} catch {
		return stopBeforeDispatch();
	}
}
