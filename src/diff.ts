import { spawn } from "node:child_process";

export type DiffSource = "working-tree" | "branch" | "last-commit";

export interface DiffResult {
  diff: string;
  source: DiffSource;
}

type RunGitFn = (args: string[], cwd: string) => Promise<{ stdout: string; code: number }>;

function defaultRunGit(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      resolve({ stdout, code: code ?? -1 });
    });
    proc.on("error", (err) => {
      reject(err);
    });
  });
}

async function tryDefaultBranch(runGit: RunGitFn, cwd: string): Promise<string | null> {
  // First attempt: git symbolic-ref refs/remotes/origin/HEAD
  try {
    const result = await runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
    if (result.code === 0 && result.stdout.trim()) {
      const branch = result.stdout.trim().replace(/^refs\/remotes\/origin\//, "");
      if (branch) return branch;
    }
  } catch {
    // symbolic-ref can fail; fall through to next attempt
  }

  // Second attempt: try "main"
  const mainResult = await runGit(["rev-parse", "--verify", "main"], cwd);
  if (mainResult.code === 0) return "main";

  // Third attempt: try "master"
  const masterResult = await runGit(["rev-parse", "--verify", "master"], cwd);
  if (masterResult.code === 0) return "master";

  return null;
}

export async function resolveDiff(
  cwd: string,
  runGit?: RunGitFn,
): Promise<DiffResult> {
  const git = runGit ?? defaultRunGit;

  // Check if cwd is a git repo by running the first strategy.
  // If git fails with an error (not just non-zero exit), it's not a repo.
  let initialCheck: { stdout: string; code: number };
  try {
    initialCheck = await git(["diff", "HEAD"], cwd);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    throw new Error(`${cwd} is not a git repository`);
  }

  // Strategy a: working tree diff
  if (initialCheck.stdout.trim()) {
    return { diff: initialCheck.stdout, source: "working-tree" };
  }

  // Strategy b/c: branch diff — find default branch first
  const defaultBranch = await tryDefaultBranch(git, cwd);
  if (defaultBranch) {
    const branchDiff = await git(["diff", `${defaultBranch}...HEAD`], cwd);
    if (branchDiff.stdout.trim()) {
      return { diff: branchDiff.stdout, source: "branch" };
    }
  }

  // Strategy d: last commit diff
  const lastCommitDiff = await git(["diff", "HEAD~1..HEAD"], cwd);
  if (lastCommitDiff.stdout.trim()) {
    return { diff: lastCommitDiff.stdout, source: "last-commit" };
  }

  // Strategy e: all empty — throw with tried-list
  let triedParts = [
    "working tree (clean)",
  ];
  if (defaultBranch) {
    triedParts.push(`${defaultBranch}...HEAD (empty or no default branch)`);
  } else {
    triedParts.push("branch diff (no default branch found)");
  }
  triedParts.push("HEAD~1..HEAD (empty or no prior commit)");

  throw new Error(
    `no diff found in ${cwd}. Tried: ${triedParts.join(", ")}.`,
  );
}
