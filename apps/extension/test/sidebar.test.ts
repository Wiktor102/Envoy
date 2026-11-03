import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createSidebarController } from "../src/ui/sidebar";

function rect(bottom: number, extra: Record<string, number> = {}): DOMRect {
	return { left: 0, top: 0, right: 0, bottom, width: 0, height: 0, x: 0, y: 0, ...extra } as unknown as DOMRect;
}

function setup(sidebarBottom: number) {
	const dom = new JSDOM('<div id="sidebar"></div>', { url: "https://www.messenger.com/t/123" });
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		HTMLElement: dom.window.HTMLElement,
		MutationObserver: dom.window.MutationObserver,
		innerWidth: 1024,
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
	});
	Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 900 });
	const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
	sidebar.innerHTML = `<input type="search" placeholder="Search Messenger" /><div><a href="/t/123">chat</a></div>`;
	const search = sidebar.querySelector<HTMLElement>("input")!;
	// jsdom has no layout engine; the sidebar below the fold is the fixture.
	search.getBoundingClientRect = () => rect(52, { left: 8, width: 340, height: 36 });
	sidebar.getBoundingClientRect = () => rect(sidebarBottom, { left: 0, width: 380, height: sidebarBottom });
	const host = document.createElement("envoy-root");
	host.getBoundingClientRect = () => rect(104, { left: 0, width: 380, height: 36 });
	const panel = document.createElement("div");
	panel.getBoundingClientRect = () => rect(140, { left: 0, top: 104, width: 380, height: 36 });
	const sidebarController = createSidebarController(
		host,
		panel,
		() => {},
		() => {},
	);
	sidebarController.update();
	return { dom, panel, sidebarController };
}

test("clamps the panel to the viewport when the sidebar extends below the fold", () => {
	const { dom, panel, sidebarController } = setup(1400);
	assert.equal(panel.style.top, "104px");
	assert.equal(panel.style.height, "796px");
	sidebarController.destroy();
	dom.window.close();
});

test("sizes the panel to the sidebar when it fits the window", () => {
	const { dom, panel, sidebarController } = setup(520);
	assert.equal(panel.style.top, "104px");
	assert.equal(panel.style.height, "416px");
	sidebarController.destroy();
	dom.window.close();
});
