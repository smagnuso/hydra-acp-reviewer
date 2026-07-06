# hydra-acp-reviewer

Adversarial-but-honest code review for hydra-acp. You type `/review`; your
agent forks a session, feeds it the diff plus an adversarial rubric, and
returns a structured critique — blocking issues first, then should-fix
items, then nits, with proposed minimal fixes and an explicit "checked
and found OK" section.

## How you use it

Run `/review` from any chat session. By default the reviewer targets the
files the current session's tool calls have edited — the "what did we just
do" surface. If the session touched nothing, it falls back to `git diff HEAD`
in the workspace. Either way, you get a clickable link to jump into the
forked review session.

```
user> /review codex

agent> Reviewing with codex ...
       [forks session, sends seed prompt]
       [Review session](hydra://sessions/b7f3a...)
       [clickable link — click to jump into the review]
```

Or review a specific path without an agent override:

```
user> /review src/auth.ts

agent> Reviewing with default agent ...
       [forks session, feeds contents of src/auth.ts]
       [Review session](hydra://sessions/c9d1e...)
```

Free-form focus works too — tell the reviewer what to look for:

```
user> /review "check for open redirects in login flow"

agent> Reviewing with default agent ...
       [forks session, adds focus to seed prompt]
       [Review session](hydra://sessions/e4a2f...)
```

## Command reference

| Form | Effect |
|------|--------|
| `/review` | Fork a review of files touched by this session; falls back to `git diff HEAD` if the session touched nothing. |
| `/review <agent>` | Same, but use a specific installed agent (e.g. `codex`). |
| `/review <path>` | Review a specific file instead of the session-touched set. |
| `/review <agent> <path>` | Agent override + path target. |
| `/review "<focus>"` | Free-form focus string quoted to pass as review instructions. |
| `--agent <id>` / `--path <p>` | Explicit flag forms, combinable with positionals. |
| `--model <id>` | Override the model on the forked review session (e.g. `--model claude-opus-4-7`). |
| `--scope=cwd` | Force git-diff-of-cwd scope; bypass session-touched-files detection. |

## Scope resolution

The reviewer picks a target in this order:

1. **Explicit path** (`/review <path>` or `--path <p>`) — review that file.
2. **Session-touched** — query the daemon's `GET /v1/sessions/:id/diff` for a
   per-file diff reconstructed from the session's tool-call payloads. This is
   the default and matches user intent for "review what we just did."
3. **Git fallback** — if the session touched nothing, fall through to
   `git diff HEAD`, then default-branch merge-base, then `HEAD~1..HEAD`.

Force the git fallback with `--scope=cwd` when you want a workspace-wide diff
regardless of session activity.

Note: the session-diff endpoint does not represent file deletions today;
deleted files won't appear under the session-touched default.

## Setup

### Install

From npm (recommended):

```sh
npm install -g @hydra-acp/cli @hydra-acp/reviewer
```

Or from source:

```sh
git clone https://github.com/smagnuso/hydra-acp-reviewer.git ~/dev/hydra-acp/reviewer
cd ~/dev/hydra-acp/reviewer
npm install
npm run build
```

### Register as a transformer

```sh
hydra-acp transformer add hydra-acp-reviewer
hydra-acp daemon restart
```

Or pointed at a local build:

```sh
hydra-acp transformer add hydra-acp-reviewer \
  --command node \
  --args ~/dev/hydra-acp/reviewer/dist/index.js
hydra-acp daemon restart
```

## Environment

The reviewer reads its connection info from env vars injected by the
daemon when spawned as a transformer. You don't normally set these by hand.

| Env var | Default | Notes |
|---------|---------|-------|
| `HYDRA_ACP_TOKEN` | (required) | Bearer token. Injected by the daemon. |
| `HYDRA_ACP_DAEMON_URL` | `http://127.0.0.1:55514` | HTTP base of the hydra daemon. |
| `HYDRA_ACP_WS_URL` | derived from `HYDRA_ACP_DAEMON_URL` | WebSocket endpoint. |
| `HYDRA_ACP_TRANSFORMER_NAME` | (set by daemon) | Presence flips the binary into transformer mode; absence runs the CLI. |
| `DEBUG` | `false` | Verbose logging. |

## Tests

```sh
npm test         # command, diff, reviewer, rubric
npm run lint     # tsc --noEmit
npm run build    # tsup -> dist/index.js
npm run watch    # rebuild on change
```

## Status

Functional for /review with fork wiring, diff resolution (dirty tree,
branch diff, last-commit fallback), adversarial rubric seeding, and
hydra:// URL emission. Ready for use as a standalone review tool or in
conjunction with the planner's competition and tiered-agent patterns.

## License

MIT.
