// English and Polish strings for the extension panel and its statuses.
// The Messenger page language wins when present; otherwise the browser UI
// language is used, falling back to English. Fixed backend task details
// localize through the details tables; model-written agent text and agent
// chat entries stay as sent.
import { en } from "./locales/en";
import { pl } from "./locales/pl";
import type { ExtensionStrings } from "./locales/strings";

export type { ExtensionStrings };

export type Locale = "en" | "pl";

export function resolveLocale(tag: string | null | undefined): Locale {
	return tag?.trim().toLowerCase().startsWith("pl") ? "pl" : "en";
}

function extensionUiLanguage(): string | null {
	if (typeof chrome === "undefined") return null;
	try {
		return chrome.i18n?.getUILanguage?.() ?? null;
	} catch {
		return null;
	}
}

export function detectLocale(): Locale {
	const page = globalThis.document?.documentElement?.lang;
	if (page) return resolveLocale(page);
	return resolveLocale(extensionUiLanguage() ?? globalThis.navigator?.language ?? null);
}

// Messenger reloads on a language change, but a programmatic lang switch
// should still repaint the panel without one.
export function observeLocaleChange(onChange: (locale: Locale) => void): () => void {
	let current = detectLocale();
	const notify = () => {
		const next = detectLocale();
		if (next === current) return;
		current = next;
		onChange(next);
	};
	const observer = new MutationObserver(notify);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
	window.addEventListener("languagechange", notify);
	return () => {
		observer.disconnect();
		window.removeEventListener("languagechange", notify);
	};
}

export function format(template: string, vars: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (match, name: string) => String(vars[name] ?? match));
}

export const STRINGS: Record<Locale, ExtensionStrings> = { en, pl };

export function getStrings(locale: Locale = detectLocale()): ExtensionStrings {
	return STRINGS[locale];
}

// Only Polish needs real plural forms here; English keeps its single shape.
export function loadedMessagesText(locale: Locale, count: number): string {
	if (locale !== "pl") return `${count} loaded messages.`;
	const rule = new Intl.PluralRules("pl").select(count);
	if (rule === "one") return `${count} załadowana wiadomość.`;
	if (rule === "few") return `${count} załadowane wiadomości.`;
	return `${count} załadowanych wiadomości.`;
}
