import { webcrypto } from "node:crypto";
import { afterEach } from "node:test";
import { JSDOM } from "jsdom";
import { bindMessengerDocument } from "../../src/messenger/chat-adapter";

// Each fixture closes its own DOM even when an assertion throws midway.
const openDoms = new Set<JSDOM>();

afterEach(() => {
	for (const dom of openDoms) dom.window.close();
	openDoms.clear();
});

export function setup(path = "/t/123") {
	const dom = new JSDOM('<main role="main"></main>', { url: `https://www.messenger.com${path}` });
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		location: dom.window.location,
		MutationObserver: dom.window.MutationObserver,
	});
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
	// jsdom has no layout engine; elements in these fixtures are rendered.
	dom.window.HTMLElement.prototype.getClientRects = () => [1] as unknown as DOMRectList;
	const main = dom.window.document.querySelector<HTMLElement>("main")!;
	main.style.overflowY = "auto";
	Object.defineProperty(main, "clientHeight", { configurable: true, value: 400 });
	Object.defineProperty(main, "scrollHeight", { configurable: true, value: 400 });
	bindMessengerDocument();
	openDoms.add(dom);
	return dom;
}

export function setMessages(html: string) {
	document.querySelector("main")!.innerHTML = html;
}

export const fixture = `
	<div data-scope="messages_table">
		<div role="row"><div dir="auto">Hello <span dir="auto">there</span></div></div>
		<div role="row"><div dir="auto">&lt;script&gt;alert(1)&lt;/script&gt;</div></div>
		<button><span dir="auto">Reply</span></button>
		<div aria-hidden="true"><span dir="auto">Hidden</span></div>
	</div>`;

// Structure based on the rendered Facebook Messenger message scopes; all content is synthetic.
export const replyAndReactionFixture = `
	<div role="article"><div data-scope="messages_table">
		<div><h4 dir="auto">You replied to Alex</h4></div>
		<div><div role="button" aria-label="Przejdź do wiadomości, na którą odpowiadasz">
			<span>Oryginalna wiadomość: </span><span dir="auto">Original text</span>
		</div></div>
		<div><span dir="auto"><div dir="auto">My answer</div></span></div>
	</div></div>
	<div role="article"><div data-scope="messages_table">
		<div><span dir="auto"><div dir="auto">Another message</div></span></div>
		<div role="button" aria-label="1 reakcja z 😆; zobacz, kto na to zareagował."><img alt="😆"></div>
		<div role="toolbar"><div role="button" aria-label="Add reaction"><img alt="👍"></div></div>
	</div></div>`;

export const photoFixture = `
	<div role="article"><div data-scope="messages_table">
		<a href="/messenger_media/?attachment_id=1"><img alt="" src="https://example.test/one"></a>
	</div></div>
	<div role="article"><div data-scope="messages_table">
		<span dir="auto">A caption</span>
		<a href="https://www.facebook.com/messenger_media/?attachment_id=2"><img alt="" src="https://example.test/two"></a>
		<a href="https://www.facebook.com/messenger_media/?attachment_id=3"><img alt="" src="https://example.test/three"></a>
		<div role="button" aria-label="1 reakcja"><img alt="😆"></div>
	</div></div>
	<div role="article"><div data-scope="messages_table">
		<h4 dir="auto">You replied to Alex</h4>
		<div role="button" aria-label="Przejdź do wiadomości, na którą odpowiadasz"><img alt="Zdjęcie" src="https://example.test/preview"></div>
		<span dir="auto">Nice photo</span>
	</div></div>
	<div role="article"><div data-scope="messages_table">
		<span dir="auto">Just text</span><img alt="avatar" src="https://example.test/avatar">
		<a href="https://example.test/messenger_media/?attachment_id=4">external</a>
	</div></div>`;
