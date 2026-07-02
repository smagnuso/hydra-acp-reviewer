// Resolve the review target from the session's server-side aggregated diff.
//
// The daemon exposes GET /v1/sessions/:id/diff?fold=true, which returns a
// per-file diff reconstructed from the session's tool_call payloads. That IS
// the "files this session touched" answer — no git, no filesystem read.
//
// Response shape (per PROTOCOL.md:395-407):
//   [{ path: string, hunks: [{ oldText, newText }], created: boolean }]
//
// Deletes are NOT representable in this response. Callers should surface that
// caveat in the seed so the reviewer isn't surprised by missing files.

export interface SessionDiffFile {
  path: string;
  hunks: Array<{ oldText: string; newText: string }>;
  created: boolean;
}

export interface SessionTouchedResult {
  diff: string;
  paths: string[];
  createdPaths: Set<string>;
  source: "session-touched";
}

export type FetchSessionDiff = (
  sessionId: string,
) => Promise<SessionDiffFile[] | null>;

function isValidHunk(v: unknown): v is { oldText: string; newText: string } {
  if (typeof v !== "object" || v === null)
  {
    return false;
  }
  const o = v as Record<string, unknown>;
  return typeof o.oldText === "string" && typeof o.newText === "string";
}

function isSessionDiffFile(v: unknown): v is SessionDiffFile {
  if (typeof v !== "object" || v === null)
  {
    return false;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.path !== "string" || o.path.length === 0)
  {
    return false;
  }
  if (typeof o.created !== "boolean")
  {
    return false;
  }
  if (!Array.isArray(o.hunks))
  {
    return false;
  }
  return o.hunks.every(isValidHunk);
}

function renderFile(file: SessionDiffFile): string {
  const lines: string[] = [];
  if (file.created)
  {
    lines.push("--- /dev/null");
  }
  else
  {
    lines.push(`--- a/${file.path}`);
  }
  lines.push(`+++ b/${file.path}`);
  file.hunks.forEach((hunk, i) => {
    const n = i + 1;
    lines.push(`<<< OLD (hunk ${n}) >>>`);
    lines.push(hunk.oldText);
    lines.push(`<<< NEW (hunk ${n}) >>>`);
    lines.push(hunk.newText);
  });
  return lines.join("\n");
}

export async function resolveSessionTouchedDiff(
  sessionId: string,
  fetchSessionDiff: FetchSessionDiff,
): Promise<SessionTouchedResult | null> {
  let raw: SessionDiffFile[] | null;
  try {
    raw = await fetchSessionDiff(sessionId);
  } catch {
    return null;
  }

  if (!raw || raw.length === 0)
  {
    return null;
  }

  const valid = raw.filter(isSessionDiffFile);
  if (valid.length === 0)
  {
    return null;
  }

  valid.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const diff = valid.map(renderFile).join("\n\n");
  const paths = valid.map((f) => f.path);
  const createdPaths = new Set(valid.filter((f) => f.created).map((f) => f.path));

  return { diff, paths, createdPaths, source: "session-touched" };
}
