import { defineContentScript } from "wxt/utils/define-content-script";
import { createEnvoyController } from "../src/controller";
import { bindMessengerDocument } from "../src/messenger/chat-adapter";
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
		bindMessengerDocument();
		const controller = createEnvoyController();
		const unmount = mountEnvoyUi(controller);
		ctx.onInvalidated(() => {
			unmount();
			controller.destroy();
		});
	},
});
