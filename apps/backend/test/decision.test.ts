import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDashes } from "@envoy/contracts";
import { parseDecision } from "../src/agent/decision.js";
import { SYSTEM_PROMPT } from "../src/agent/system-prompt.js";
import { checkedText } from "../src/tasks/task-text.js";

test("model decisions replace em and en dashes with hyphens", () => {
	for (const action of ["reply", "ask", "finish"] as const) {
		for (const text of ["Słucham — powiedz więcej", "Spotkajmy się – jutro?", "Tak — jutro – pasuje"]) {
			const decision = parseDecision({ action, text });
			assert.equal(decision.action, action);
			assert.ok(decision.action !== "wait" && !decision.text.includes("—"), `${action}: ${text}`);
			assert.ok(decision.action !== "wait" && !decision.text.includes("–"), `${action}: ${text}`);
		}
	}
	assert.deepEqual(parseDecision({ action: "reply", text: "Słucham — powiedz więcej" }), {
		action: "reply",
		text: "Słucham - powiedz więcej",
	});
	assert.deepEqual(parseDecision({ action: "ask", text: "Jutro–pojutrze?" }), {
		action: "ask",
		text: "Jutro-pojutrze?",
	});
});

test("dash normalization keeps hyphens and other text intact", () => {
	assert.equal(normalizeDashes("dobrze - tak"), "dobrze - tak");
	assert.equal(normalizeDashes("no dashes here"), "no dashes here");
	assert.equal(normalizeDashes("a—b–c"), "a-b-c");
});

test("the system prompt steers the model away from em and en dashes", () => {
	assert.match(SYSTEM_PROMPT, /em dash/);
	assert.match(SYSTEM_PROMPT, /en dash/);
});

test("user goal text keeps its dashes", () => {
	assert.equal(checkedText("Cel — jutro – pojutrze"), "Cel — jutro – pojutrze");
});
