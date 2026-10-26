import { defineContentScript } from "wxt/utils/define-content-script";
import { mountEnvoyUi } from "../src/ui/mount";

export default defineContentScript({
	matches: ["https://www.messenger.com/*", "https://messenger.com/*"],
	runAt: "document_idle",
	main(ctx) {
		const host = mountEnvoyUi();
		ctx.onInvalidated(() => host.remove());
		// TODO: Connect the Messenger adapter once safe chat access is implemented.
	},
});
