import { readFileSync } from "node:fs";
import { defineTransformer, type CommandInvocation, type Context, type SetupContext } from "@hydra-acp/transformer";
import { parseReviewInvocation } from "./command.js";
import { resolveDiff } from "./diff.js";
import { composeSeed } from "./seed.js";
import { DEFAULT_RUBRIC } from "./rubric.js";
import {
  resolveSessionTouchedDiff,
  type FetchSessionDiff,
  type SessionDiffFile,
} from "./session-touched.js";

export async function handleReview(
  inv: CommandInvocation,
  ctx: Context,
): Promise<{ ok: boolean; message?: string }> {
  // a. Fetch installed agents
  let agentIds: string[] = [];
  try {
    const agents = (await ctx.rpc("hydra-acp/agents/list", {})) as {
      agents?: Array<{ id: string; installed?: string }>;
    };
    agentIds = (agents?.agents ?? [])
      .filter((a) => a.installed === "yes")
      .map((a) => a.id);
  } catch (err) {
    return { ok: false, message: `failed to list agents: ${(err as Error).message}` };
  }

  // b. Parse intent
  let intent: {
    agent?: string;
    path?: string;
    focus?: string;
    forceCwdScope?: boolean;
    model?: string;
  };
  try {
    intent = parseReviewInvocation(inv.argv, agentIds);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }

  // Build the default session-diff fetcher, closing over ctx.fetch so the
  // reviewer package never has to know about HYDRA_ACP_DAEMON_URL / _TOKEN.
  const defaultFetchSessionDiff: FetchSessionDiff = async (sid) => {
    try {
      const res = await ctx.fetch(
        `/v1/sessions/${encodeURIComponent(sid)}/diff?fold=true`,
      );
      if (!res.ok)
      {
        return null;
      }
      const body = (await res.json()) as unknown;
      return Array.isArray(body) ? (body as SessionDiffFile[]) : null;
    } catch {
      return null;
    }
  };

  // c. Resolve target: path arg > forced cwd scope > session-touched > git fallback.
  let diff: string | undefined;
  let filePath: string | undefined;
  let fileContents: string | undefined;
  let touchedPaths: string[] | undefined;
  let createdPaths: Set<string> | undefined;

  if (intent.path) {
    try {
      const absPath = intent.path.startsWith("/") ? intent.path : `${ctx.cwd}/${intent.path}`;
      fileContents = readFileSync(absPath, "utf8");
      filePath = intent.path;
    } catch (err) {
      return { ok: false, message: `cannot read ${intent.path}: ${(err as Error).message}` };
    }
  } else if (intent.forceCwdScope) {
    try {
      const result = await resolveDiff(ctx.cwd);
      diff = result.diff;
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  } else {
    const touched = await resolveSessionTouchedDiff(
      ctx.sessionId,
      defaultFetchSessionDiff,
    );
    if (touched)
    {
      diff = touched.diff;
      touchedPaths = touched.paths;
      createdPaths = touched.createdPaths;
    }
    else
    {
      try {
        const result = await resolveDiff(ctx.cwd);
        diff = result.diff;
      } catch (err) {
        return {
          ok: false,
          message: `No changes found: session touched no files, and git diff of ${ctx.cwd} is empty (${(err as Error).message}). Try /review <path> or /review --scope=cwd to target something specific.`,
        };
      }
    }
  }

  // d. Compose seed prompt
  const seed = composeSeed({
    rubric: DEFAULT_RUBRIC,
    diff,
    filePath,
    fileContents,
    focus: intent.focus,
    touchedPaths,
    createdPaths,
  });

  // e. Fork the session (synthesis is the default mode in the daemon)
  const forkParams: Record<string, unknown> = {
    sessionId: ctx.sessionId,
  };
  if (intent.agent) {
    forkParams.agentId = intent.agent;
  }
  if (intent.model) {
    forkParams.model = intent.model;
  }

  let forkResult: { sessionId?: string };
  try {
    forkResult = (await ctx.rpc("hydra-acp/session/fork", forkParams)) as { sessionId?: string };
  } catch (err) {
    return { ok: false, message: `fork failed: ${(err as Error).message}` };
  }

  const newId = forkResult.sessionId;
  if (!newId) {
    return { ok: false, message: "fork returned no sessionId" };
  }

  // f. Attach to the forked session so we can send prompts into it.
  //    hydra-acp/session/fork mints the session but does not auto-attach
  //    the caller; without attach, session/prompt would fail with
  //    "not attached to session".
  try {
    await ctx.rpc("hydra-acp/transformer/attach", { sessionId: newId });
  } catch (err) {
    return { ok: false, message: `failed to attach to forked session: ${(err as Error).message}` };
  }

  // g. Send seed prompt to the fork via message/emit with route "queue".
  //    This queues the prompt in the daemon-side prompt queue for the
  //    forked session. The RPC resolves when the daemon accepts it;
  //    the agent's response streams independently.
  void ctx.rpc("hydra-acp/message/emit", {
    sessionId: newId,
    method: "session/prompt",
    envelope: {
      sessionId: newId,
      prompt: [{ type: "text", text: seed }],
    },
    route: "queue",
  }).catch(() => void 0);

  // h. Return the clickable link as the command reply. The daemon broadcasts
  //    result.text (i.e. our `message`) as a synthetic agent_message_chunk in
  //    the parent session (PROTOCOL.md:1325), so we do NOT also call
  //    ctx.emitMessage — that would duplicate the message.
  const url = `hydra://sessions/${newId}`;
  const linkMd = `[Review session](${url})`;
  return { ok: true, message: linkMd };
}

export const reviewerDefinition = defineTransformer({
  setup(ctx: SetupContext) {
    // Single-purpose extension: register only the bare verb. The daemon
    // advertises this as `/reviewer`, `/hydra reviewer`, and
    // `/hydra hydra-acp-reviewer`. Registering an additional `"review"`
    // verb would clutter the palette with near-duplicate `/reviewer
    // review` entries for no behavioral gain.
    ctx.registerCommand(
      { verb: "", description: "Adversarially review changes in a forked session.", argsHint: "[<agent>] [<path>] [--model <id>] [--scope=cwd]" },
      handleReview,
    );
  },
  hooks: {},
});
