interface DocumentBinding {
	document: Document;
	window: Window;
	path: string;
	navigated: boolean;
	observer: MutationObserver;
	onPopState: () => void;
	onNavigate: (event: Event) => void;
	navigation: EventTarget | undefined;
}

let documentBinding: DocumentBinding | undefined;

// Bind before any asynchronous read. The rendered message table does not expose
// a verified thread ID, so a document that has navigated must be reloaded.
export function bindMessengerDocument(): void {
	if (typeof document === "undefined" || typeof window === "undefined") return;
	if (documentBinding?.document === document) return;
	if (documentBinding) {
		documentBinding.observer.disconnect();
		documentBinding.window.removeEventListener("popstate", documentBinding.onPopState);
		documentBinding.navigation?.removeEventListener("navigate", documentBinding.onNavigate);
	}

	const currentWindow = window;
	const currentDocument = document;
	const path = currentWindow.location.pathname;
	const onPopState = () => {
		if (currentWindow.location.pathname !== path) binding.navigated = true;
	};
	const onNavigate = (event: Event) => {
		const destination = (event as Event & { destination?: { url?: string } }).destination?.url;
		try {
			if (destination && new URL(destination, currentWindow.location.href).pathname !== path) binding.navigated = true;
		} catch {
			binding.navigated = true;
		}
	};
	const observer = new MutationObserver(onPopState);
	const navigation = (currentWindow as Window & { navigation?: EventTarget }).navigation;
	const binding: DocumentBinding = {
		document: currentDocument,
		window: currentWindow,
		path,
		navigated: false,
		observer,
		onPopState,
		onNavigate,
		navigation,
	};
	documentBinding = binding;
	observer.observe(currentDocument, { childList: true, subtree: true });
	currentWindow.addEventListener("popstate", onPopState);
	navigation?.addEventListener("navigate", onNavigate);
}

export function documentHasNavigated(): boolean {
	bindMessengerDocument();
	if (!documentBinding) return true;
	if (documentBinding.path !== location.pathname) documentBinding.navigated = true;
	return documentBinding.navigated;
}

bindMessengerDocument();

export function getChatId(): string | null {
	const match = location.pathname.match(/(?:^|\/)t\/([^/]+)\/?$/);
	return match?.[1] ?? null;
}
