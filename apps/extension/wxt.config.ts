import { defineConfig } from "wxt";

export default defineConfig({
	manifestVersion: 3,
	imports: false,
	manifest: {
		name: "Envoy",
		description: "Delegate a Messenger conversation to an agent with a goal and reply controls.",
		permissions: ["storage"],
		// No toolbar popup. The content script mounts goal setup inside Messenger.
		minimum_chrome_version: "116",
	},
});
