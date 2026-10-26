# Envoy plan

## Goal and scope

Build an agent that gathers information from people and moves a Messenger conversation toward a goal. The first demo arranges a meeting across several messages, within the user's stated availability and permissions.

For the hackathon: one delegated text conversation, one goal, a dedicated Messenger tab, and replies that auto-send after a default 10-second intervention window. Include send now, edit, cancel, pause, takeover, and clear agent status. The agent can wait, reply, ask the user, or finish.

## Architecture

`Messenger tab <-> extension connector <-> backend <-> Meta Model API`

- The extension reads available messages and chat identity, shows the Envoy controls, and executes validated sends in the dedicated tab.
- The backend stores the goal, permissions, conversation context, open questions, agreements, and pending actions. It calls Meta Model API directly and decides when another reasoning step is needed.
- Each pending reply belongs to a specific chat and conversation state. New messages invalidate it. Editing, cancellation, pause, or takeover stop the countdown. Recheck state immediately before sending and record the result to prevent duplicates. Verify uncertain sends before retrying.
- A closed, navigated, or disconnected agent tab pauses sending. Keep task state outside the extension worker and browser access behind a connector interface. A future hosted browser should use the same contract, with only one connector controlling the chat.

Use HTTPS, standard encryption at rest, backend-held API credentials, minimal stored context, deletion, and a short retention policy. The backend and Meta process readable messages.

## TODO

- [ ] Prove Messenger access: identify one test chat, read incoming messages, and send in a background tab while the user chats elsewhere.
- [ ] Choose the implementation stack, storage, and extension/backend connection; scaffold both components.
- [ ] Build the goal and permission setup, conversation state, and Meta reasoning loop. Support waiting, replying, escalation, and completion.
- [ ] Add the reply countdown and controls, stale-reply rejection, duplicate prevention, and send confirmation.
- [ ] Test new messages during generation/countdown, late model results after takeover, reconnects, restarts, tab closure, and chat changes.
- [ ] Finish a repeatable demo with willing participants: agree on a meeting, revise or cancel one reply, and escalate a decision outside the brief.

## Later and undecided

Defer hosted browsing, multiple delegated chats, attachments, calendar/general tools, message-length-based delays, and custom encryption. T3/MCP and provider selection are outside this version. Confirm the stack, model, hosting, retention period, and delay settings during implementation.
