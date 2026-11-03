// Messenger does not expose a stable sidebar API. Find the chat search field and
// the smallest sidebar-sized ancestor that also contains the chat list.
function findSidebar(): {
	sidebar: HTMLElement;
	insertionPoint: HTMLElement;
} | null {
	const searches = document.querySelectorAll<HTMLElement>(
		'input[type="search"], input[placeholder], input[aria-label], [role="searchbox"]',
	);

	for (const search of searches) {
		const label = `${search.getAttribute("placeholder") ?? ""} ${search.getAttribute("aria-label") ?? ""}`;
		if (
			search.getAttribute("role") !== "searchbox" &&
			search.getAttribute("type") !== "search" &&
			!/search|szukaj/i.test(label)
		) {
			continue;
		}

		const searchRect = search.getBoundingClientRect();
		if (searchRect.width < 150 || searchRect.height < 20 || searchRect.left > innerWidth / 3) continue;

		let sidebar = search.parentElement;
		while (sidebar && sidebar !== document.body) {
			const rect = sidebar.getBoundingClientRect();
			if (
				rect.width >= searchRect.width &&
				rect.width <= 600 &&
				rect.height >= 240 &&
				rect.bottom > searchRect.bottom + 150 &&
				(sidebar.querySelector('a[href*="/t/"]') || sidebar.querySelector("envoy-root"))
			) {
				break;
			}

			sidebar = sidebar.parentElement;
		}
		if (!sidebar || sidebar === document.body) continue;

		let insertionPoint: HTMLElement = search;
		while (insertionPoint.parentElement && insertionPoint.parentElement !== sidebar) {
			const next = insertionPoint.nextElementSibling;
			if (
				next instanceof HTMLElement &&
				next.getBoundingClientRect().height >= 40 &&
				next.getBoundingClientRect().width >= searchRect.width * 0.7
			) {
				break;
			}

			insertionPoint = insertionPoint.parentElement;
		}
		if (!insertionPoint.parentElement) continue;
		return { sidebar, insertionPoint };
	}

	return null;
}

// Keep the overlay aligned with Messenger and restore the chat list on cleanup.
export function createSidebarController(
	host: HTMLElement,
	panel: HTMLElement,
	onSidebarMissing: () => void,
	onAvailabilityChange: (available: boolean) => void = () => {},
) {
	let sidebar: HTMLElement | null = null;
	let frame = 0;
	let available: boolean | undefined;
	const inertElements = new Map<HTMLElement, boolean>();

	function setAvailable(next: boolean) {
		if (available === next) return;
		available = next;
		onAvailabilityChange(next);
	}

	function updateChatListAccessibility() {
		for (const [element, wasInert] of inertElements) element.inert = wasInert;
		inertElements.clear();
		if (panel.hidden || !sidebar || !host.isConnected) return;
		let current: HTMLElement = host;
		while (current !== sidebar && current.parentElement) {
			for (let sibling = current.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
				if (sibling instanceof HTMLElement) {
					inertElements.set(sibling, sibling.inert);
					sibling.inert = true;
				}
			}

			current = current.parentElement;
		}
	}

	function positionPanel() {
		if (!sidebar || !host.isConnected) return;
		const sidebarRect = sidebar.getBoundingClientRect();
		const tabRect = host.getBoundingClientRect();
		// The detected sidebar can extend below the fold when the page
		// scrolls. Clamp the panel to the viewport so its tail — pending
		// reply, reply controls, answer box — stays reachable.
		const bottom = Math.min(sidebarRect.bottom, window.innerHeight);
		panel.style.left = `${sidebarRect.left}px`;
		panel.style.top = `${tabRect.bottom}px`;
		panel.style.width = `${sidebarRect.width}px`;
		panel.style.height = `${Math.max(0, bottom - tabRect.bottom)}px`;
		// A transformed Facebook ancestor can change the origin of fixed elements.
		if (!panel.hidden) {
			const panelRect = panel.getBoundingClientRect();
			panel.style.left = `${sidebarRect.left + sidebarRect.left - panelRect.left}px`;
			panel.style.top = `${tabRect.bottom + tabRect.bottom - panelRect.top}px`;
		}
	}

	function update() {
		frame = 0;
		const found = findSidebar();
		if (!found) {
			setAvailable(false);
			onSidebarMissing();
			host.remove();
			sidebar = null;
			return;
		}

		sidebar = found.sidebar;
		if (found.insertionPoint.nextElementSibling !== host) {
			found.insertionPoint.insertAdjacentElement("afterend", host);
		}
		setAvailable(host.isConnected);

		updateChatListAccessibility();
		positionPanel();
	}

	function scheduleUpdate() {
		// Stop local sends as soon as Messenger detaches the controls. The next
		// frame will reattach them if the sidebar was merely remounted.
		if (!host.isConnected) setAvailable(false);
		if (!frame) frame = requestAnimationFrame(update);
	}

	const observer = new MutationObserver(scheduleUpdate);
	observer.observe(document.body, { childList: true, subtree: true });
	window.addEventListener("resize", scheduleUpdate);
	window.addEventListener("scroll", scheduleUpdate, true);

	return {
		update,
		refresh() {
			updateChatListAccessibility();
			positionPanel();
		},
		destroy() {
			setAvailable(false);
			observer.disconnect();
			onSidebarMissing();
			window.removeEventListener("resize", scheduleUpdate);
			window.removeEventListener("scroll", scheduleUpdate, true);
			if (frame) cancelAnimationFrame(frame);
			host.remove();
		},
	};
}
