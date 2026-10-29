// Page shortcuts see the shadow host as the event target, not the textarea.
export function isolateTextInput(input: HTMLTextAreaElement) {
	for (const type of ["keydown", "keypress", "keyup"]) {
		input.addEventListener(type, (event) => event.stopPropagation());
	}
}
