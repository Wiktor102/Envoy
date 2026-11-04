import {
	DEFAULT_REPLY_SETTINGS,
	MAX_REPLY_DELAY_SECONDS,
	MIN_REPLY_DELAY_SECONDS,
	normalizeReplySettings,
	type ReplySettings,
} from "@envoy/contracts";
import type { ExtensionStrings } from "../i18n";
import { replyDelayHint } from "./view-format";
import type { ViewElements } from "./view-elements";

// The settings popover: Dev mode and reply sending, remembered in extension storage.
export function createSettingsPanel(
	host: HTMLElement,
	container: HTMLElement,
	{
		settingsButton,
		settingsPopover,
		developerToggle,
		developerDetails,
		autoSendToggle,
		delayRange,
		delayMin,
		delayMax,
		delayHint,
	}: ViewElements,
	onReplySettingsChange: () => void,
) {
	let destroyed = false;
	let developerMode = false;
	let developerModeChanged = false;
	let replySettings: ReplySettings = { ...DEFAULT_REPLY_SETTINGS };
	let replySettingsChanged = false;
	let preferenceWrite = Promise.resolve();
	let settingsOpen = false;

	function setDeveloperMode(enabled: boolean) {
		developerMode = enabled;
		developerToggle.setAttribute("aria-checked", String(enabled));
		developerDetails.hidden = !enabled;
	}

	function setSettingsOpen(open: boolean) {
		settingsOpen = open;
		settingsPopover.hidden = !open;
		settingsButton.setAttribute("aria-expanded", String(open));
	}

	settingsButton.addEventListener("click", () => {
		setSettingsOpen(!settingsOpen);
	});

	container.addEventListener("keydown", (event) => {
		if ((event as KeyboardEvent).key !== "Escape" || !settingsOpen) return;
		setSettingsOpen(false);
		settingsButton.focus();
	});

	// Pointer down precedes the toggle click; the button and popover are
	// excluded so opening still works. Closed shadow roots hide their
	// internals from outside listeners, so inside clicks are classified
	// from within the shadow tree and only host-external clicks here.
	container.addEventListener("pointerdown", (event) => {
		if (!settingsOpen) return;
		const path = event.composedPath();
		if (path.includes(settingsPopover) || path.includes(settingsButton)) return;
		setSettingsOpen(false);
	});

	function closeSettingsOnOutsidePointer(event: Event) {
		if (!settingsOpen || event.composedPath().includes(host)) return;
		setSettingsOpen(false);
	}

	document.addEventListener("pointerdown", closeSettingsOnOutsidePointer);

	// Field values change only here, so a render during typing keeps the draft.
	function setReplySettings(next: ReplySettings) {
		replySettings = next;
		delayMin.value = String(next.minDelaySeconds);
		delayMax.value = String(next.maxDelaySeconds);
		onReplySettingsChange();
	}

	async function restorePreferences() {
		try {
			const saved = await chrome.storage.local.get(["envoyDeveloperMode", "envoyReplySettings"]);
			// A slow storage read must not undo a choice made in this view.
			if (destroyed) return;
			if (!developerModeChanged) setDeveloperMode(saved.envoyDeveloperMode === true);
			if (!replySettingsChanged) setReplySettings(normalizeReplySettings(saved.envoyReplySettings));
		} catch {
			// Keep the defaults if extension storage is unavailable.
		}
	}

	function savePreference(items: Record<string, unknown>) {
		// Preserve the last choice even when storage writes complete slowly.
		preferenceWrite = preferenceWrite.then(async () => {
			try {
				await chrome.storage.local.set(items);
			} catch {
				// The control still works for this view if saving is unavailable.
			}
		});
	}

	developerToggle.addEventListener("click", () => {
		developerModeChanged = true;
		const enabled = !developerMode;
		setDeveloperMode(enabled);
		savePreference({ envoyDeveloperMode: enabled });
	});

	function changeReplySettings(next: ReplySettings) {
		replySettingsChanged = true;
		setReplySettings(next);
		savePreference({ envoyReplySettings: next });
	}

	autoSendToggle.addEventListener("click", () => {
		changeReplySettings({ ...replySettings, autoSend: !replySettings.autoSend });
	});

	// The edited bound wins: the other bound moves to keep the range ordered.
	function changeDelay(edited: "min" | "max") {
		const value = (edited === "min" ? delayMin : delayMax).valueAsNumber;
		if (!Number.isFinite(value)) {
			setReplySettings(replySettings);
			return;
		}
		const seconds = Math.min(MAX_REPLY_DELAY_SECONDS, Math.max(MIN_REPLY_DELAY_SECONDS, Math.round(value)));
		const { minDelaySeconds, maxDelaySeconds } = replySettings;
		changeReplySettings({
			...replySettings,
			minDelaySeconds: edited === "min" ? seconds : Math.min(minDelaySeconds, seconds),
			maxDelaySeconds: edited === "max" ? seconds : Math.max(maxDelaySeconds, seconds),
		});
	}

	delayMin.addEventListener("change", () => changeDelay("min"));
	delayMax.addEventListener("change", () => changeDelay("max"));

	return {
		autoSend: () => replySettings.autoSend,
		close: () => setSettingsOpen(false),
		// Fills the fields, then restores saved choices. Runs once the view can render.
		start() {
			setReplySettings(replySettings);
			void restorePreferences();
		},
		render(strings: ExtensionStrings, active: boolean) {
			const { autoSend } = replySettings;
			autoSendToggle.setAttribute("aria-checked", String(autoSend));
			delayRange.setAttribute("aria-disabled", String(!autoSend));
			delayMin.disabled = !autoSend;
			delayMax.disabled = !autoSend;
			delayHint.textContent = replyDelayHint(replySettings, strings) + (active ? strings.delayAppliesNow : "");
		},
		destroy() {
			destroyed = true;
			document.removeEventListener("pointerdown", closeSettingsOnOutsidePointer);
		},
	};
}
