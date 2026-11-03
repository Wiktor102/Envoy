import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedOrigin } from "../src/origin.js";

test("browser origins other than Chrome extensions cannot reach the WebSocket", () => {
	assert.equal(allowedOrigin(undefined), true);
	assert.equal(allowedOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"), true);
	assert.equal(allowedOrigin("https://example.com"), false);
	assert.equal(allowedOrigin("http://127.0.0.1:3001"), false);
	assert.equal(allowedOrigin("null"), false);
	assert.equal(allowedOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop.evil.example"), false);
});
