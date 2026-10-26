# Envoy

An AI agent that talks things through for you, built for the Meta Global AI Developer Hackathon.

Give Envoy a goal in a private Messenger conversation, such as "Arrange a meeting. I can do Tuesday after 17:00 or Thursday evening. Ask me if neither works." It follows the discussion, asks for missing information, remembers agreements, and responds within the limits you set.

Envoy runs through a browser extension and a small backend powered by Meta Model API. It uses a dedicated Messenger tab so you can keep chatting elsewhere. Before each reply sends, you get a short countdown to edit or cancel it. You can pause the agent or take over at any time.

The hackathon version handles one text conversation and one goal at a time, with a default 10-second reply delay. Your computer must stay awake and the agent's tab must remain open and connected. Reliable background reading and sending is coming later.

## Scaffold status

The code is a compileable foundation only. The backend exposes one tRPC `health` query over WebSocket. The extension mounts a small goal setup window and agent controls inside Messenger using Shadow DOM. There is no toolbar popup or separate browser window.

Only the backend health button works. Goal setup and task controls are disabled. Messenger access, sending, countdowns, task lifecycle, persistence, agent reasoning, Meta API calls, and authentication are TODOs. No messages are read or sent, and no API keys are needed.

## Prerequisites

- Node.js 22.19 or newer.
- pnpm 10.20.0, pinned in `package.json`. Install with `npm install --global pnpm@10.20.0` if needed.
- Chrome 116 or newer to load the extension.

## Commands

Run these from the repository root:

```sh
pnpm install
cp apps/backend/.env.example apps/backend/.env.development
cp apps/backend/.env.example apps/backend/.env.production
pnpm dev
pnpm typecheck
pnpm build
```

`pnpm dev` builds the shared packages, then starts the contracts compiler, backend watcher, and WXT development process. WXT may open Chrome for development. Use `pnpm dev:backend` or `pnpm dev:extension` to start either app separately. Restart development after changing the backend router's exported types so the extension sees fresh declarations.

`pnpm typecheck` builds contracts and backend declarations before checking all three workspaces. `pnpm build` builds each workspace in dependency order. Installation and extension typechecking generate the ignored `.wxt` types automatically.

Run `pnpm format` to format the workspace or `pnpm format:check` to check formatting. Prettier uses tabs with a width of 4. `pnpm install` sets up the Husky pre-commit hook, which runs Prettier on staged files through lint-staged and stages the formatting changes.

After a production build, start the backend and check its real WebSocket procedure in another terminal:

```sh
pnpm start:backend
```

```sh
pnpm health:prod
```

The health command should print `{"status":"ok","service":"envoy-backend"}`. Use `pnpm health` for the development backend.

The backend loads `apps/backend/.env.development` for `dev` and `health`, and `.env.production` for `start` and `health:prod`. These local files are ignored by Git. Copy the committed `.env.example` to both files when setting up a new checkout, using `Copy-Item` in PowerShell or `cp` in a POSIX shell. Set `NODE_ENV=production` in `.env.production`. Restart the backend after changing its env file. Existing process environment variables take precedence over file values.

The example sets `HOST=127.0.0.1` and `PORT=3001`. The server and health command use the configured host and port. The extension still connects to `ws://127.0.0.1:3001`, so keep those defaults when using it. API credentials, when added, belong only in the backend env files. Deployment, authentication, and service-worker connection recovery remain future work.

If a local certificate proxy causes dependency downloads to fail, configure Node to trust your organization's certificate store. This workspace does not disable TLS verification.

## Load the extension

After `pnpm build`, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/extension/.output/chrome-mv3`. Open or reload `https://www.messenger.com/` or a `https://www.facebook.com/messages/` page to see the injected placeholders. If the extension is already loaded, reload it in `chrome://extensions` first. Reload the chat page after navigating to it from elsewhere on Facebook. With the backend running, **Check backend health** checks the content script to background worker to tRPC path.

The production manifest contains only the Messenger and Facebook messages content-script matches and background worker. It requests no additional extension permissions. WXT adds development permissions for its reload tooling during `pnpm dev`.

## Workspace layout

| Workspace            | Contents                                                                                        | Build output                |
| -------------------- | ----------------------------------------------------------------------------------------------- | --------------------------- |
| `packages/contracts` | Browser-neutral types and the default reply delay constant                                      | `dist` ESM and declarations |
| `apps/backend`       | tRPC router/server, task service/repository interfaces, connector and agent placeholders        | `dist` ESM and declarations |
| `apps/extension`     | WXT manifest config, MV3 worker, Messenger content script, DOM adapter placeholder, injected UI | `.output/chrome-mv3`        |

Contracts and backend use TypeScript `NodeNext` resolution and `.js` imports for emitted Node ESM. The extension uses WXT's generated configuration and bundler resolution. Node ambient types belong to the backend; Chrome and DOM ambient types belong to the extension; contracts include neither.

Workspace imports resolve through package exports to built files. The backend exposes `@envoy/backend/router` as a types-only export, and the extension uses `import type` for `AppRouter`. No server implementation or credentials enter the browser bundle. Task state and pending replies will belong to the backend, with browser access behind `BrowserConnector`.

See [PLAN.md](PLAN.md) for the intended behavior. Configuration follows the [WXT TypeScript guide](https://wxt.dev/guide/essentials/config/typescript.html) and [tRPC WebSocket transport documentation](https://trpc.io/docs/server/websockets).
