import { defineConfig } from "wxt";

export default defineConfig({
	manifestVersion: 3,
	imports: false,
	manifest: {
		name: "Envoy",
		description: "Placeholder Messenger agent scaffold. Chat automation is not implemented.",
		// No toolbar popup. The content script mounts goal setup inside Messenger.
		minimum_chrome_version: "116",
	},
});
