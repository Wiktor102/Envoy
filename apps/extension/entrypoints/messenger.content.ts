import { defineContentScript } from "wxt/utils/define-content-script";
import { mountEnvoyUi } from "../src/ui/mount";

export default defineContentScript({
	matches: [
		"https://www.messenger.com/*",
		"https://messenger.com/*",
		"https://www.facebook.com/messages/*",
		"https://facebook.com/messages/*",
	],
	runAt: "document_idle",
	main(ctx) {
		const unmount = mountEnvoyUi();
		ctx.onInvalidated(unmount);
		// TODO: Connect the Messenger adapter once safe chat access is implemented.
	},
});
