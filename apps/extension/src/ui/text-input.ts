// Page shortcuts see the shadow host as the event target, not the field.
export function isolateTextInput(input: HTMLTextAreaElement | HTMLInputElement) {
	for (const type of ["keydown", "keypress", "keyup"]) {
		input.addEventListener(type, (event) => event.stopPropagation());
	}
}
