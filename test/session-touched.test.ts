import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSessionTouchedDiff, type FetchSessionDiff, type SessionDiffFile } from "../src/session-touched.js";

const stub = (data: SessionDiffFile[] | null): FetchSessionDiff => async () => data;
const throwing: FetchSessionDiff = async () => {
  throw new Error("network kaboom");
};

describe("resolveSessionTouchedDiff", () => {
  it("returns null on null response", async () => {
    const r = await resolveSessionTouchedDiff("s1", stub(null));
    assert.equal(r, null);
  });

  it("returns null on empty array", async () => {
    const r = await resolveSessionTouchedDiff("s1", stub([]));
    assert.equal(r, null);
  });

  it("returns null when fetcher throws", async () => {
    const r = await resolveSessionTouchedDiff("s1", throwing);
    assert.equal(r, null);
  });

  it("renders happy path with sorted paths, created flagged", async () => {
    const files: SessionDiffFile[] = [
      { path: "b.ts", hunks: [{ oldText: "old-b", newText: "new-b" }], created: false },
      { path: "a.ts", hunks: [{ oldText: "", newText: "created-content" }], created: true },
    ];
    const r = await resolveSessionTouchedDiff("s1", stub(files));
    assert.ok(r);
    assert.deepEqual(r.paths, ["a.ts", "b.ts"]);
    assert.equal(r.createdPaths.has("a.ts"), true);
    assert.equal(r.createdPaths.has("b.ts"), false);
    assert.equal(r.source, "session-touched");
    assert.ok(r.diff.includes("--- /dev/null"));
    assert.ok(r.diff.includes("+++ b/a.ts"));
    assert.ok(r.diff.includes("--- a/b.ts"));
    assert.ok(r.diff.includes("+++ b/b.ts"));
    assert.ok(r.diff.includes("<<< OLD (hunk 1) >>>"));
    assert.ok(r.diff.includes("<<< NEW (hunk 1) >>>"));
    assert.ok(r.diff.includes("created-content"));
    assert.ok(r.diff.includes("new-b"));
  });

  it("numbers multiple hunks starting from 1", async () => {
    const files: SessionDiffFile[] = [
      {
        path: "x.ts",
        created: false,
        hunks: [
          { oldText: "o1", newText: "n1" },
          { oldText: "o2", newText: "n2" },
          { oldText: "o3", newText: "n3" },
        ],
      },
    ];
    const r = await resolveSessionTouchedDiff("s1", stub(files));
    assert.ok(r);
    assert.ok(r.diff.includes("<<< OLD (hunk 1) >>>"));
    assert.ok(r.diff.includes("<<< OLD (hunk 2) >>>"));
    assert.ok(r.diff.includes("<<< OLD (hunk 3) >>>"));
    assert.ok(r.diff.includes("<<< NEW (hunk 3) >>>"));
  });

  it("filters malformed entries; returns null if all bad", async () => {
    const bad = [
      { path: 42, hunks: [], created: false },
      { hunks: [], created: false },
      { path: "ok", hunks: null, created: false },
      { path: "", hunks: [], created: false },
      { path: "bad-hunks", hunks: [{ notOldText: 1 }], created: false },
    ] as unknown as SessionDiffFile[];
    const r = await resolveSessionTouchedDiff("s1", stub(bad));
    assert.equal(r, null);
  });

  it("filters files whose hunks have wrong shape", async () => {
    const mixed = [
      { path: "good.ts", hunks: [{ oldText: "o", newText: "n" }], created: false },
      { path: "bad.ts", hunks: [{ oldText: "o" }], created: false },
    ] as unknown as SessionDiffFile[];
    const r = await resolveSessionTouchedDiff("s1", stub(mixed));
    assert.ok(r);
    assert.deepEqual(r.paths, ["good.ts"]);
    assert.strictEqual(r.diff.includes("undefined"), false);
  });

  it("keeps valid entries mixed with invalid ones", async () => {
    const mixed = [
      { path: "good.ts", hunks: [{ oldText: "o", newText: "n" }], created: false },
      { hunks: [], created: false } as unknown as SessionDiffFile,
    ];
    const r = await resolveSessionTouchedDiff("s1", stub(mixed));
    assert.ok(r);
    assert.deepEqual(r.paths, ["good.ts"]);
  });
});
