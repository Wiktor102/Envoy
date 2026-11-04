<img src="assets/envoy-logo.png" alt="Envoy logo" width="128" height="128" />

# Envoy

Envoy is an experimental Messenger agent built for the Meta Global AI Developer Hackathon. Give it a goal and limits for conversations in private chat and groups. It reads the messages loaded in a dedicated Messenger tab, asks Meta Muse Spark 1.3 (`muse-spark-1.3`, through Meta Model API) what to do, and can propose a reply. By default it sends after a short countdown unless you step in.

Messenger's DOM is not a stable API. Envoy deliberately stops when it cannot identify the chat, sender, newest messages, or composer confidently. Its panel and Messenger label matching cover English and Polish only, and selectors may need adjusting for a particular account or UI version.

## Setup

Requirements: Node.js 22.19 or newer, pnpm 10.20.0, Chrome 116 or newer, and a [Meta Model API](https://dev.meta.ai/docs/quickstart) key.

```sh
pnpm install
cp apps/backend/.env.example apps/backend/.env.development
cp apps/backend/.env.example apps/backend/.env.production
```

Put `MODEL_API_KEY` in the backend env files and set `NODE_ENV=production` in `.env.production`. Never put the key in the extension.

For development run `pnpm dev`, or `pnpm dev:backend` and `pnpm dev:extension` separately. Restart after backend router type changes so the extension picks up the new declarations.

For a production build:

```sh
pnpm build
pnpm start:backend
```

In `chrome://extensions`, enable Developer mode and load `apps/extension/.output/chrome-mv3` as an unpacked extension. Reload it after rebuilding.

If local HTTPS inspection (such as Avast on Windows) makes model requests fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, launch the backend with `NODE_OPTIONS=--use-system-ca`. Do not disable certificate verification.

## Delegate a conversation

1. Open the private conversation on messenger.com or facebook.com/messages in a dedicated tab and reload it. Reload after selecting a different conversation too.
2. Open the **Envoy** tab in the chats sidebar, enter the goal and limits, and select **Start task**. Keep the computer awake and the tab open.
3. Envoy decides when you start, update, resume, or answer it, and on new incoming or edited messages. It can wait, propose a reply, ask you in the agent chat, or mark the task complete, which it may also do right after a send. Answer questions there directly; use **Update instructions** only to change the goal. Either discards a pending reply.
4. A proposed reply sends after a countdown (10 seconds by default). **Edit** stops it; select **Save reply**, then **Send now** to send it. **Cancel reply** stops it and waits for a new message. **Try again** drafts an alternative. **Pause** stops pending work; **Take over** ends the task.
5. A disconnected or navigated tab pauses the task. Reopen the same chat, reload it, and use **Reconnect** and then **Resume**. If a send could not be confirmed, check the conversation first: Envoy will not retry an uncertain send.

The backend runs one task at a time. Envoy only sees messages Messenger has rendered and cannot infer missing history. A visible outgoing bubble shows that Messenger displayed the send, not that it was delivered.

The gear on the Envoy tab opens settings, saved in the browser. Turn off **Auto-send replies** so each reply waits for **Send now**, or set a fixed or random 1–600 second delay. **Dev mode** shows message history, IDs, and connection controls, and prefixes generated replies with `> `.

## Privacy and storage

The extension sends the chosen chat's loaded context and your instructions to the local backend, which sends them and the 4 newest media attachments (not files) to Meta Model API. Message bodies and provider errors are not logged. Conversation text cannot overwrite your instructions, but the model is only told to treat it as untrusted, so a crafted message could still influence a reply.

Tasks exist only in backend memory, so restarting the backend deletes them and any pending send. Ended tasks are deleted after one hour unless a send needs verification; **Delete task** removes one sooner.

The backend listens on `127.0.0.1:3001`. The extension hardcodes that address, so keep the default `HOST` and `PORT`. It rejects ordinary web page origins, but local programs and installed extensions are not authenticated, so do not expose it to a network.
