import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { detectLocale, format, getStrings, loadedMessagesText, resolveLocale, STRINGS } from "../src/i18n";

test("resolveLocale supports english and polish tags", () => {
	for (const tag of ["pl", "pl-PL", "PL", " pl "]) assert.equal(resolveLocale(tag), "pl");
	for (const tag of ["en", "en-US", "de", "fr", "", null, undefined]) assert.equal(resolveLocale(tag), "en");
});

test("detectLocale prefers the page language over the browser language", () => {
	const dom = new JSDOM("", { url: "https://www.messenger.com/" });
	const previousDocument = globalThis.document;
	const previousChrome = (globalThis as Record<string, unknown>).chrome;
	Object.assign(globalThis, {
		document: dom.window.document,
		chrome: { i18n: { getUILanguage: () => "en-US" } },
	});
	try {
		dom.window.document.documentElement.lang = "pl";
		assert.equal(detectLocale(), "pl");
		dom.window.document.documentElement.lang = "de";
		assert.equal(detectLocale(), "en");
		dom.window.document.documentElement.lang = "";
		assert.equal(detectLocale(), "en");
	} finally {
		if (previousDocument === undefined) delete (globalThis as Record<string, unknown>).document;
		else globalThis.document = previousDocument;
		if (previousChrome === undefined) delete (globalThis as Record<string, unknown>).chrome;
		else (globalThis as Record<string, unknown>).chrome = previousChrome;
		dom.window.close();
	}
});

test("detectLocale uses the extension UI language without a page", () => {
	const previousChrome = (globalThis as Record<string, unknown>).chrome;
	(globalThis as Record<string, unknown>).chrome = { i18n: { getUILanguage: () => "pl-PL" } };
	try {
		assert.equal(detectLocale(), "pl");
	} finally {
		if (previousChrome === undefined) delete (globalThis as Record<string, unknown>).chrome;
		else (globalThis as Record<string, unknown>).chrome = previousChrome;
	}
});

test("format fills placeholders and keeps unknown ones", () => {
	assert.equal(format("Chat: {id}", { id: "chat-1" }), "Chat: chat-1");
	assert.equal(format("Sending in {seconds}s.", { seconds: 5 }), "Sending in 5s.");
	assert.equal(format("Hello {name}", {}), "Hello {name}");
});

test("loaded messages keep the english shape and use polish plurals", () => {
	assert.equal(loadedMessagesText("en", 1), "1 loaded messages.");
	assert.equal(loadedMessagesText("en", 5), "5 loaded messages.");
	assert.equal(loadedMessagesText("pl", 1), "1 załadowana wiadomość.");
	assert.equal(loadedMessagesText("pl", 3), "3 załadowane wiadomości.");
	assert.equal(loadedMessagesText("pl", 5), "5 załadowanych wiadomości.");
	assert.equal(loadedMessagesText("pl", 0), "0 załadowanych wiadomości.");
});

test("both locales define the same non-empty keys with matching placeholders", () => {
	const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
	assert.deepEqual(Object.keys(STRINGS.pl).sort(), Object.keys(STRINGS.en).sort());
	for (const [key, english] of Object.entries(STRINGS.en)) {
		const polish = STRINGS.pl[key as keyof typeof STRINGS.pl];
		if (typeof english === "string" && typeof polish === "string") {
			assert.ok(english.length > 0, key);
			assert.ok(polish.length > 0, key);
			assert.deepEqual(placeholders(polish), placeholders(english), key);
			continue;
		}
		assert.equal(key, "details");
		const enDetails = english as Record<string, string>;
		const plDetails = polish as Record<string, string>;
		assert.ok(typeof enDetails === "object" && enDetails !== null, key);
		assert.ok(typeof plDetails === "object" && plDetails !== null, key);
		assert.deepEqual(Object.keys(plDetails).sort(), Object.keys(enDetails).sort());
		for (const [code, enText] of Object.entries(enDetails)) {
			const plText = plDetails[code]!;
			assert.ok(enText.length > 0, `details.${code}`);
			assert.ok(plText.length > 0, `details.${code}`);
			assert.deepEqual(placeholders(plText), placeholders(enText), `details.${code}`);
		}
	}
});

test("polish strings translate the panel", () => {
	const strings = getStrings("pl");
	assert.equal(strings.chatsTab, "Czaty");
	assert.equal(strings.startTask, "Rozpocznij zadanie");
	assert.equal(strings.sendNow, "Wyślij teraz");
	assert.equal(strings.statusWaiting, "Oczekiwanie na nową wiadomość");
	assert.equal(format(strings.sendingIn, { seconds: 7 }), "Wysłanie za 7 s.");
	assert.equal(
		strings.details.auto_send_off,
		"Automatyczne wysyłanie jest wyłączone. Wybierz Wyślij teraz, gdy odpowiedź będzie gotowa.",
	);
});

test("english detail codes keep the legacy backend wording", () => {
	const strings = getStrings("en");
	assert.equal(strings.details.auto_send_off, "Automatic sending is off. Choose Send now when it is ready.");
	assert.equal(strings.details.considering_conversation, "Considering the conversation.");
	assert.equal(
		strings.details.tab_disconnected_send_uncertain,
		"The agent tab disconnected. A send may have completed; check the conversation.",
	);
});
