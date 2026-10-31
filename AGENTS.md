# Envoy

Envoy is a browser extension and backend that delegates a Messenger
conversation toward a user's goal.

## Scope

- Inspect the relevant implementation before making claims. Treat
  documentation as context that may need verification.

## Planning and discussing changes

- Question every idea before implementing it. Probe assumptions,
  edge cases, failure modes, and simpler alternatives.
- Identify the core problem first. Do not implement a proposed
  solution until the underlying issue and its scope are clear.
- Keep relevant open github issues in mind. Check whether the
  discussion duplicates, conflicts with, or resolves any of them.
- If a new problem or idea comes up that is not directly part of
  the current task, offer to create a properly tagged issue for
  it on github instead of expanding the current scope.

## Development

- Assume that the dev server is already running.
- Follow existing code and formatting conventions. Avoid unrelated edits.

### Live testing

Whenever asked to perform live test please use your browser use capability.
Utilize already opened and authenticated messenger and/or facebook tabs.
**Never use the preview browser.** Expect general; computer-use requests
to error when trying to interact with chrome windows due to ambiguous URLs -
that's why you ned to inspect chrome tabs with dedicated chrome tools.

## Git

- Use schematic commit messages with the modified project area,
  such as fix(extension): preserve message line breaks.
- Keep commits atomic: one feature or bug fix per commit.
- Explain the concrete problem, resulting behavior, and validation
  in PR descriptions. Those descriptions must be clear (easy to grasp)
  and must be kept up-to-date when Pr scope changes.
