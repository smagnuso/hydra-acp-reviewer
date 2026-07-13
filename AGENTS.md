# AGENTS.md

Brief for AI agents working in this repo.

## What this is

`hydra-acp-reviewer` — adversarial-but-honest code review for Hydra. The
user types `/reviewer` in any chat session; their agent forks a new
session, feeds it the diff plus an adversarial rubric, and returns a
structured critique — blocking issues first, then should-fix items, then
nits, with proposed minimal fixes and an explicit "checked and found OK"
section.

By default the reviewer targets the files the current session's tool
calls have edited (the "what did we just do" surface). If the session
touched nothing, it falls back to `git diff HEAD` in the workspace.

## How it fits into Hydra

Hydra is a multi-client ACP session daemon. Full docs and wire protocol
live at [`smagnuso/hydra-acp`](https://github.com/smagnuso/hydra-acp) —
see `cli/PROTOCOL.md` for command-registration and session-fork
semantics.

**This repo is built on top of
[`@hydra-acp/transformer`](https://github.com/smagnuso/hydra-acp-transformer)**,
which is why there's no `bridge.ts` here — the library owns the WS
connection, hook dispatch, and intercept plumbing. Entry point uses
`runTransformer` (`src/index.ts`); the reviewer itself is a
`defineTransformer` definition (`src/reviewer.ts`) that registers the
`/reviewer` slash command via the library's `commands` hook and drives
review-session creation through `ctx.rpc("hydra-acp/transformer/attach",
…)` and friends.

When the command runs it uses the daemon's REST + WSS surfaces to
inspect the current session's tool history, build a diff, and spawn a
review session (optionally on a different agent) seeded with the rubric.

## Layout

- `src/index.ts` — entry point
- `src/cli.ts` — top-level extension lifecycle
- `src/command.ts` — `/reviewer` slash command handler
- `src/reviewer.ts` — the review-session orchestration
- `src/session-touched.ts` — extracts "files this session edited" from
  tool history
- `src/diff.ts` — diff construction (session-touched + git-diff fallback)
- `src/seed.ts` — the seed prompt sent to the review session
- `src/rubric.ts` — the adversarial review rubric

## Build & test

```
npm install
npm run build     # tsup → dist/
npm test          # vitest
npm run lint
```

Ships as `hydra-acp-reviewer` on PATH. Registered via
`hydra-acp extension add hydra-acp-reviewer`.

## Conventions

- TypeScript, ESM, tsup, vitest.
- The rubric is the product. Changes to it are user-visible behavior
  changes — coordinate and document.
- Review sessions are normal hydra sessions and must not leak the
  originating session's private state beyond the diff and seed prompt.
- The fallback `git diff HEAD` runs shell-side; be careful about shell
  quoting and non-git workspaces.

## Gotchas

- Session-touched extraction depends on tool-call shapes that vary by
  agent. Handle unknown tool kinds defensively — a missing kind means
  "we didn't touch anything," not "crash."
- The forked review session inherits the daemon's spawn environment. If
  the user overrides the agent (e.g. `/reviewer codex`), verify it exists
  in the registry before spawning.
- The clickable `hydra://sessions/<id>` link is a client-side convention.
  Ensure the id is fully materialized before returning it.
- **Session-touched diff comes from the daemon**, not reconstructed
  locally from tool calls (`session-touched.ts` calls
  `GET /v1/sessions/:id/diff?fold=true`). The response format is a
  custom `<<< OLD (hunk N) >>>` / `<<< NEW >>>` block, NOT unified diff.
  Editing the rubric to expect unified-diff shape will misread.
- **File deletes are not representable** in the session-touched diff
  format. The seed prompt must call this out; otherwise the reviewer
  silently misses file removals.
- **Fork ≠ attach**: `hydra-acp/session/fork` mints a session but does
  not attach. A subsequent `transformer/attach` is required before any
  `message/emit` (`reviewer.ts`). Missing this errors with "not attached
  to session".
- **The returned `message` doubles as an emitted chat line** — the
  daemon broadcasts `result.text` as a synthetic
  `agent_message_chunk`. Calling `ctx.emitMessage` on the same content
  duplicates the review-link line.
- **`parseReviewInvocation` heuristic** (`command.ts`): a single
  positional argument is treated as an agent id if it appears in
  `installedAgents`, otherwise as a file path. Renaming an agent id
  turns old muscle memory into a (probably wrong) path lookup.
- **`@hydra-acp/transformer` is a hard dependency of this repo's
  behavior**, not just its wire plumbing. Changes to the library's hook
  catalog, `Context` shape, `defineTransformer` API, or `runTransformer`
  lifecycle can break this repo silently. When bumping the library
  version, run this repo's tests before shipping the library release.

## Updating this file

If you discover a durable, non-obvious invariant while working here — the
kind of thing you wish had been in this file when you started — flag it
in your final turn summary so the human can decide whether to add it. Do
not silently edit AGENTS.md mid-task. Prefer additions to `## Gotchas`
over reworking existing sections; never delete a gotcha without checking
that the underlying invariant is actually gone.
