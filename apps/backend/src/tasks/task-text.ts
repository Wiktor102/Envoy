import { hasControlCharacters, MAX_TASK_TEXT_LENGTH } from "@envoy/contracts";

export function checkedText(value: string | undefined): string {
	const text = value?.trim();
	if (!text || text.length > MAX_TASK_TEXT_LENGTH)
		throw new Error(`Enter text between 1 and ${MAX_TASK_TEXT_LENGTH} characters.`);
	return text;
}

export function checkedReply(value: string | undefined): string {
	if (value && hasControlCharacters(value)) {
		throw new Error("Replies must be a single line without control characters.");
	}
	return checkedText(value);
}
