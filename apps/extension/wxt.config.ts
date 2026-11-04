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
		icons: {
			16: "/icon-16.png",
			32: "/icon-32.png",
			48: "/icon-48.png",
			128: "/icon-128.png",
		},
		action: {
			default_title: "Envoy",
			default_icon: {
				16: "/icon-16.png",
				32: "/icon-32.png",
				48: "/icon-48.png",
				128: "/icon-128.png",
			},
		},
	},
});
