import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveDiff } from "../src/diff.js";

// Helper to build a runGit stub that returns specific results per call.
// Calls are pushed onto an array so the implementation's sequence can be
// verified or selectively responded to.
function makeStub(responses: Array<{ stdout: string; code: number }>): {
  fn: Parameters<typeof resolveDiff>[1];
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn = async (args: string[], _cwd: string) => {
    calls.push(args);
    const resp = responses.shift();
    if (!resp) {
      return { stdout: "", code: 0 };
    }
    return resp;
  };
  return { fn, calls };
}

// For the "not a git repo" case we need runGit to throw.
function makeThrowStub(): Parameters<typeof resolveDiff>[1] {
  return async () => {
    const err = new Error("fatal: not a git repository");
    (err as NodeJS.ErrnoException).code = "ENOTGIT";
    throw err;
  };
}

describe("resolveDiff", () => {
  it("dirty working tree → source is working-tree", async () => {
    const expectedDiff = "diff --git a/foo.ts b/foo.ts\n+new line\n";
    const { fn, calls } = makeStub([{ stdout: expectedDiff, code: 0 }]);

    const result = await resolveDiff("/some/path", fn);

    assert.strictEqual(result.source, "working-tree");
    assert.strictEqual(result.diff, expectedDiff);
    // Only ran git diff HEAD; didn't probe for default branch.
    assert.deepStrictEqual(calls, [["diff", "HEAD"]]);
  });

  it("clean tree with symbolic-ref → origin/HEAD → branch source", async () => {
    const branchDiff = "diff --git a/bar.ts b/bar.ts\n+another change\n";
    const { fn, calls } = makeStub([
      { stdout: "", code: 0 }, // git diff HEAD (clean)
      { stdout: "refs/remotes/origin/main\n", code: 0 }, // symbolic-ref
      { stdout: branchDiff, code: 0 }, // git diff main...HEAD
    ]);

    const result = await resolveDiff("/some/path", fn);

    assert.strictEqual(result.source, "branch");
    assert.strictEqual(result.diff, branchDiff);
    assert.deepStrictEqual(calls, [
      ["diff", "HEAD"],
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      ["diff", "main...HEAD"],
    ]);
  });

  it("clean tree, symbolic-ref fails → tries main via rev-parse → branch source", async () => {
    const branchDiff = "diff --git a/baz.ts b/baz.ts\n+change in baz\n";
    const { fn, calls } = makeStub([
      { stdout: "", code: 0 }, // git diff HEAD (clean)
      { stdout: "", code: 1 }, // symbolic-ref fails
      { stdout: "abc123\n", code: 0 }, // rev-parse main succeeds
      { stdout: branchDiff, code: 0 }, // git diff main...HEAD
    ]);

    const result = await resolveDiff("/some/path", fn);

    assert.strictEqual(result.source, "branch");
    assert.strictEqual(result.diff, branchDiff);
    assert.deepStrictEqual(calls, [
      ["diff", "HEAD"],
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      ["rev-parse", "--verify", "main"],
      ["diff", "main...HEAD"],
    ]);
  });

  it("clean tree, no origin/HEAD, main absent → tries master → branch source", async () => {
    const branchDiff = "diff --git a/qux.ts b/qux.ts\n+qux change\n";
    const { fn, calls } = makeStub([
      { stdout: "", code: 0 }, // git diff HEAD (clean)
      { stdout: "", code: 1 }, // symbolic-ref fails
      { stdout: "", code: 128 }, // rev-parse main fails
      { stdout: "def456\n", code: 0 }, // rev-parse master succeeds
      { stdout: branchDiff, code: 0 }, // git diff master...HEAD
    ]);

    const result = await resolveDiff("/some/path", fn);

    assert.strictEqual(result.source, "branch");
    assert.strictEqual(result.diff, branchDiff);
    assert.deepStrictEqual(calls, [
      ["diff", "HEAD"],
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      ["rev-parse", "--verify", "main"],
      ["rev-parse", "--verify", "master"],
      ["diff", "master...HEAD"],
    ]);
  });

  it("clean tree, no default branch → falls through to last-commit → source is last-commit", async () => {
    const lastCommitDiff = "diff --git a/last.ts b/last.ts\n+last commit change\n";
    const { fn, calls } = makeStub([
      { stdout: "", code: 0 }, // git diff HEAD (clean)
      { stdout: "", code: 1 }, // symbolic-ref fails
      { stdout: "", code: 128 }, // rev-parse main fails
      { stdout: "", code: 128 }, // rev-parse master fails
      { stdout: lastCommitDiff, code: 0 }, // git diff HEAD~1..HEAD
    ]);

    const result = await resolveDiff("/some/path", fn);

    assert.strictEqual(result.source, "last-commit");
    assert.strictEqual(result.diff, lastCommitDiff);
    assert.deepStrictEqual(calls, [
      ["diff", "HEAD"],
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      ["rev-parse", "--verify", "main"],
      ["rev-parse", "--verify", "master"],
      ["diff", "HEAD~1..HEAD"],
    ]);
  });

  it("all diffs empty → throws with tried-list", async () => {
    const { fn } = makeStub([
      { stdout: "", code: 0 }, // git diff HEAD (clean)
      { stdout: "", code: 1 }, // symbolic-ref fails
      { stdout: "", code: 128 }, // rev-parse main fails
      { stdout: "", code: 128 }, // rev-parse master fails
      { stdout: "", code: 0 }, // git diff HEAD~1..HEAD (empty)
    ]);

    await assert.rejects(
      async () => resolveDiff("/some/path", fn),
      (err: Error) => {
        const msg = err.message;
        assert.ok(msg.includes("no diff found in /some/path"));
        assert.ok(msg.includes("working tree (clean)"));
        assert.ok(msg.includes("HEAD~1..HEAD"));
        return true;
      },
    );
  });

  it("not a git repo → throws not-a-repo", async () => {
    await assert.rejects(
      async () => resolveDiff("/some/path", makeThrowStub()),
      (err: Error) => {
        assert.ok(
          err.message.includes("is not a git repository"),
          `Expected not-a-repo error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("clean tree with branch diff from symbolic-ref → skips main/master probes", async () => {
    const branchDiff = "diff --git a/sym.ts b/sym.ts\n+sym change\n";
    const { fn, calls } = makeStub([
      { stdout: "", code: 0 }, // git diff HEAD (clean)
      { stdout: "refs/remotes/origin/develop\n", code: 0 }, // symbolic-ref → develop
      { stdout: branchDiff, code: 0 }, // git diff develop...HEAD
    ]);

    const result = await resolveDiff("/some/path", fn);

    assert.strictEqual(result.source, "branch");
    assert.deepStrictEqual(calls, [
      ["diff", "HEAD"],
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      ["diff", "develop...HEAD"],
    ]);
  });

  it("clean tree, has default branch but no branch diff → tries last-commit", async () => {
    const lastCommitDiff = "diff --git a/last2.ts b/last2.ts\n+second last commit\n";
    const { fn, calls } = makeStub([
      { stdout: "", code: 0 }, // git diff HEAD (clean)
      { stdout: "refs/remotes/origin/main\n", code: 0 }, // symbolic-ref → main
      { stdout: "", code: 0 }, // git diff main...HEAD (empty)
      { stdout: lastCommitDiff, code: 0 }, // git diff HEAD~1..HEAD
    ]);

    const result = await resolveDiff("/some/path", fn);

    assert.strictEqual(result.source, "last-commit");
    assert.strictEqual(result.diff, lastCommitDiff);
    assert.deepStrictEqual(calls, [
      ["diff", "HEAD"],
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      ["diff", "main...HEAD"],
      ["diff", "HEAD~1..HEAD"],
    ]);
  });

  it("default branch from symbolic-ref has no prior commits → falls back to last-commit", async () => {
    // This tests the case where HEAD~1 fails because there's only one commit
    const lastCommitDiff = "diff --git a/first.ts b/first.ts\n+initial file\n";
    const { fn, calls } = makeStub([
      { stdout: "", code: 0 }, // git diff HEAD (clean)
      { stdout: "refs/remotes/origin/main\n", code: 0 }, // symbolic-ref → main
      { stdout: "", code: 0 }, // git diff main...HEAD (empty — single commit)
      { stdout: lastCommitDiff, code: 0 }, // git diff HEAD~1..HEAD succeeds
    ]);

    const result = await resolveDiff("/some/path", fn);

    assert.strictEqual(result.source, "last-commit");
    assert.deepStrictEqual(calls, [
      ["diff", "HEAD"],
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      ["diff", "main...HEAD"],
      ["diff", "HEAD~1..HEAD"],
    ]);
  });
});
