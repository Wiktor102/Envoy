# Envoy

Envoy is an experimental Messenger agent built for the Meta Global AI Developer Hackathon. Give it a goal and limits for one private text conversation. It reads the messages loaded in a dedicated Messenger tab, asks Meta Model API what to do, and can propose a reply. The backend owns the task and a default 10-second countdown. You can edit or cancel a reply, pause the task, or take over.

The implementation has synthetic tests but has not been verified against a signed-in Messenger account or a live Meta Model API key. Messenger's DOM is not a stable API. The reader and sender deliberately stop when they cannot identify the chat, sender, newest messages, or composer confidently. Validate the full flow with a willing participant before relying on it.

## Setup

Requirements: Node.js 22.19 or newer, pnpm 10.20.0, Chrome 116 or newer, and a [Meta Model API](https://dev.meta.ai/docs/quickstart) key.

```sh
pnpm install
cp apps/backend/.env.example apps/backend/.env.development
cp apps/backend/.env.example apps/backend/.env.production
```

Put `MODEL_API_KEY` in the backend env files. Set `NODE_ENV=production` in `.env.production`. `MODEL_API_MODEL` defaults to `muse-spark-1.3`; change it if your Meta account uses a different supported model. Restart the backend after changing an env file. Existing process environment variables take precedence. Never put the key in the extension.

For development run `pnpm dev`. WXT may open Chrome. To run each part separately, use `pnpm dev:backend` or `pnpm dev:extension`. Restart development after backend router type changes so the extension picks up the new declarations.

For a production build:

```sh
pnpm build
pnpm start:backend
```

In `chrome://extensions`, enable Developer mode and load `apps/extension/.output/chrome-mv3` as an unpacked extension. Reload the extension after rebuilding it.

## Delegate a conversation

1. Open the private Messenger conversation in a dedicated tab, then reload that tab. Reload after selecting a different conversation too. Envoy stops when the tab navigates because the URL may change before Messenger replaces the old messages.
2. Open the **Envoy** tab in the chats sidebar. Check the selected conversation in Messenger, enter the goal and its limits, then select **Start task**. Keep the computer awake and this tab open. You can use other tabs while it runs.
3. Envoy waits for an identifiable incoming text message and sends the goal and loaded text to Meta Model API for a decision. It can wait, propose a reply, ask you for guidance, or mark the task complete. Update the instructions and resume if it needs your input.
4. A proposed reply has a 10-second countdown. **Edit** stops it; after saving an edit, choose **Send now** to send. **Cancel reply** stops it and waits for a new message. **Pause** stops pending work; **Take over** ends the task. Envoy checks the chat, current message revision, and composer again immediately before sending.
5. A disconnected or navigated tab pauses the task. The extension asks the dedicated tab to reread the conversation while it is in the background; if the tab cannot respond, the backend pauses. Reopen the same chat, reload it, and use **Reconnect** and then **Resume**. If a send could not be confirmed, check the actual conversation before resuming or deleting the task. Envoy will not automatically retry an uncertain send.

Only the messages rendered by Messenger are visible to Envoy. It cannot infer missing history. It stops if the latest message has an unknown sender or unreadable content, or if it cannot establish the latest messages or an empty composer. Earlier messages with unknown senders or recognized attachments are labeled for the model; it cannot inspect the attachments and should ask when missing context matters. Entirely unrecognized media still pauses the reader. Message attribution and send controls depend on Messenger's rendered markup and may need adjustment for a particular account, language, or UI version. A visible outgoing bubble is evidence that Messenger displayed the send, not proof of final delivery.

Use **Dev mode** beside the sidebar tabs to show message history, chat and task IDs, and backend connection controls. It is off by default. Envoy remembers this setting in the extension on this browser.

## Privacy and storage

The extension sends the chosen chat's loaded context and your instructions to the local backend; the backend sends text and instructions to Meta Model API. Other Messenger tabs do not upload their conversation snapshots. The project does not log message bodies or provider errors. Conversation text remains untrusted input and cannot authorize changes to your instructions.

Task state, context, and pending replies exist only in backend memory. There is no database or cross-restart recovery. Restarting the backend deletes them and cannot resume a pending send. Use **Delete task** after completion or takeover to remove the in-memory record. Otherwise, ended tasks are deleted after one hour, except when a send needs user verification. Memory and messaging-style detection are not implemented.

The default backend listens at `127.0.0.1:3001` and the extension connects to `ws://127.0.0.1:3001`. Keep those defaults for local use. The server rejects ordinary web page WebSocket origins, but local programs and installed extensions are not authenticated. Do not expose this backend to a network; hosted use requires authentication, HTTPS, and an appropriate retention policy.

## Checks

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

The test suites use synthetic Messenger DOM fixtures and a fake agent. They do not replace a real Messenger or Meta API integration test. To check the production backend's WebSocket health endpoint, run `pnpm health:prod` in another terminal after starting it. The response should be `{"status":"ok","service":"envoy-backend"}`. Use `pnpm health` for the development backend.

`pnpm typecheck` and `pnpm test` build shared contracts and backend declarations first. WXT generates its ignored types during installation and extension typechecking. `pnpm format` formats the workspace; the Husky pre-commit hook formats staged files.

## Workspace layout

| Workspace            | Contents                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `packages/contracts` | Browser-neutral task, conversation, and send contracts                                        |
| `apps/backend`       | Meta Model API adapter, in-memory task service, connector boundary, and tRPC WebSocket server |
| `apps/extension`     | Messenger DOM reader and sender, background transport, and injected sidebar controls          |

Contracts and backend use TypeScript `NodeNext` resolution. The extension imports only backend router types; the server implementation and credentials do not enter its bundle. See [PLAN.md](PLAN.md) for scope and remaining work.
