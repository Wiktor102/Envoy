import { DEFAULT_REPLY_DELAY_SECONDS } from "@envoy/contracts";
import { checkBackendHealth } from "../messaging";
import { watchConversation } from "./conversation";
import styles from "./styles.css?inline";
import markup from "./view.html?raw";

// This markup is static; do not interpolate conversation text into it.
export function createEnvoyView(onSelectionChange: () => void) {
	const host = document.createElement("envoy-root");
	if (location.hostname === "facebook.com" || location.hostname.endsWith(".facebook.com")) {
		host.setAttribute("data-facebook", "");
	}

	const shadow = host.attachShadow({ mode: "closed" });
	const style = document.createElement("style");
	style.textContent = styles;
	const container = document.createElement("div");
	container.innerHTML = markup;
	container.querySelector<HTMLElement>("#envoy-reply-delay")!.textContent = String(DEFAULT_REPLY_DELAY_SECONDS);
	shadow.append(style, container);

	const chatsTab = container.querySelector<HTMLButtonElement>("#chats-tab")!;
	const envoyTab = container.querySelector<HTMLButtonElement>("#envoy-tab")!;
	const panel = container.querySelector<HTMLElement>("#envoy-panel")!;
	const healthButton = container.querySelector<HTMLButtonElement>("#envoy-health")!;
	const status = container.querySelector<HTMLElement>("#envoy-status")!;
	const conversationStatus = container.querySelector<HTMLElement>("#envoy-conversation-status")!;
	const conversationJson = container.querySelector<HTMLElement>("#envoy-conversation-json")!;
	let stopWatching: (() => void) | undefined;

	function selectTab(showEnvoy: boolean) {
		chatsTab.setAttribute("aria-selected", String(!showEnvoy));
		envoyTab.setAttribute("aria-selected", String(showEnvoy));
		chatsTab.tabIndex = showEnvoy ? -1 : 0;
		envoyTab.tabIndex = showEnvoy ? 0 : -1;
		panel.hidden = !showEnvoy;
		if (showEnvoy && !stopWatching) {
			stopWatching = watchConversation((snapshot, message) => {
				conversationStatus.textContent = message;
				conversationJson.textContent = snapshot ? JSON.stringify(snapshot, null, 2) : "";
			});
		} else if (!showEnvoy && stopWatching) {
			stopWatching();
			stopWatching = undefined;
			conversationJson.textContent = "";
			conversationStatus.textContent = "Open a conversation to read its messages.";
		}
		onSelectionChange();
	}

	chatsTab.addEventListener("click", () => selectTab(false));
	envoyTab.addEventListener("click", () => selectTab(true));
	envoyTab.tabIndex = -1;
	container.querySelector(".tabs")!.addEventListener("keydown", (event) => {
		const keyEvent = event as KeyboardEvent;
		if (keyEvent.key !== "ArrowLeft" && keyEvent.key !== "ArrowRight") return;
		keyEvent.preventDefault();
		const showEnvoy = keyEvent.key === "ArrowRight";
		selectTab(showEnvoy);
		(showEnvoy ? envoyTab : chatsTab).focus();
	});

	healthButton.addEventListener("click", async () => {
		healthButton.disabled = true;
		status.textContent = "Checking backend...";
		try {
			const reply = await checkBackendHealth();
			status.textContent = reply.ok ? "Backend healthy." : "Backend unavailable.";
		} catch {
			status.textContent = "Extension connection unavailable. Reload Messenger.";
		} finally {
			healthButton.disabled = false;
		}
	});

	return { host, panel, selectTab };
}
