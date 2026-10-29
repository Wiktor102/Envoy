import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { isolateTextInput } from "../src/ui/text-input";

test("text input keyboard events do not trigger page shortcuts or cancel typing", () => {
	const dom = new JSDOM();
	const host = dom.window.document.createElement("envoy-root");
	const shadow = host.attachShadow({ mode: "closed" });
	const textarea = dom.window.document.createElement("textarea");
	shadow.append(textarea);
	dom.window.document.body.append(host);
	isolateTextInput(textarea);

	let pageEvents = 0;
	dom.window.document.addEventListener("keydown", () => pageEvents++);
	dom.window.document.addEventListener("keypress", () => pageEvents++);
	dom.window.document.addEventListener("keyup", () => pageEvents++);
	for (const type of ["keydown", "keypress", "keyup"]) {
		const event = new dom.window.KeyboardEvent(type, { key: "l", bubbles: true, composed: true, cancelable: true });
		assert.equal(textarea.dispatchEvent(event), true);
		assert.equal(event.defaultPrevented, false);
	}
	assert.equal(pageEvents, 0);
	dom.window.close();
});
