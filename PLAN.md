# Envoy plan

## Goal and scope

Build an agent that gathers information from a person and moves a Messenger conversation toward a user-defined goal. The first demo arranges a meeting across several messages, within the user's stated availability and permissions.

The hackathon scope is one delegated text conversation, one goal, a dedicated Messenger tab, and replies that auto-send after a default 10-second intervention window. Include send now, edit, cancel, pause, takeover, and clear agent status. The agent can wait, reply, ask the user, or finish.

## Architecture

`Messenger tab <-> extension connector <-> backend <-> Meta Model API`

- The extension reads available messages and chat identity, shows the Envoy controls, and executes validated sends in the dedicated tab.
- The backend owns the goal, conversation context, pending replies, countdown, and task lifecycle. It calls Meta Model API directly. The connector boundary keeps browser access replaceable by a hosted browser later.
- A pending reply belongs to a chat and conversation revision. New messages invalidate it. Edit, cancel, pause, and takeover stop pending work. Recheck state immediately before sending, claim each command once, and require user review of an uncertain result.
- A closed, navigated, disconnected, or unavailable agent tab pauses sending. One connector owns the task. A replacement tab must reconnect explicitly after the old connection expires.
- The local prototype keeps task data in backend memory and supports deleting a finished task. API keys stay on the backend, message bodies stay out of logs, and conversation text is input rather than permission to change instructions.

## Progress and remaining work

- [x] Scaffold the extension, backend, shared contracts, and local connection.
- [x] Implement goal setup, Meta Model API reasoning, and wait/reply/ask/finish decisions.
- [x] Implement reply controls, countdowns, stale-reply invalidation, one-time claims, and uncertain-send handling.
- [x] Add synthetic checks for the Messenger adapter and task lifecycle.
- [ ] Verify Messenger DOM selectors, sender attribution, scroll position, and sending in a real signed-in session. The current adapter fails closed when it cannot establish the needed state.
- [ ] Verify the Meta Model API with a real key and run the full demo with willing participants: agree on a meeting, revise or cancel a reply, and escalate a decision outside the brief.
- [ ] Design authenticated hosting, HTTPS, encryption at rest, a short retention policy, and updated Terms of Use before exposing the backend beyond the local machine.

## Later and undecided

Defer hosted browsing, durable task storage, memory and messaging-style detection, multiple delegated chats, attachments, calendar/general tools, message-length-based delays, and custom encryption. T3/MCP and provider selection are outside this version.
