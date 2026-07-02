import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseReviewInvocation } from "../src/command.js";

const AGENTS = ["codex", "aider", "cline"];

describe("parseReviewInvocation", () => {
  it("bare (empty argv) — returns empty intent", () => {
    const result = parseReviewInvocation([], AGENTS);
    assert.deepStrictEqual(result, {});
  });

  it("one arg matching an agent → agent", () => {
    const result = parseReviewInvocation(["codex"], AGENTS);
    assert.deepStrictEqual(result, { agent: "codex" });
  });

  it("one arg not matching any agent → path", () => {
    const result = parseReviewInvocation(["src/lib.ts"], AGENTS);
    assert.deepStrictEqual(result, { path: "src/lib.ts" });
  });

  it("two args (agent + path)", () => {
    const result = parseReviewInvocation(["codex", "src/lib.ts"], AGENTS);
    assert.deepStrictEqual(result, { agent: "codex", path: "src/lib.ts" });
  });

  it("two args where first doesn't match agents → error", () => {
    assert.throws(
      () => parseReviewInvocation(["notanagent", "src/lib.ts"], AGENTS),
      (err: Error) =>
        err.message.includes("Expected first positional to be an agent id") &&
        err.message.includes("notanagent"),
    );
  });

  it("explicit --agent flag overrides positional interpretation", () => {
    const result = parseReviewInvocation(["--agent", "codex"], AGENTS);
    assert.deepStrictEqual(result, { agent: "codex" });
  });

  it("explicit --path flag overrides positional interpretation", () => {
    const result = parseReviewInvocation(["--path", "src/lib.ts"], AGENTS);
    assert.deepStrictEqual(result, { path: "src/lib.ts" });
  });

  it("--agent + positional path", () => {
    const result = parseReviewInvocation(["--agent", "codex", "src/lib.ts"], AGENTS);
    assert.deepStrictEqual(result, { agent: "codex", path: "src/lib.ts" });
  });

  it("quoted focus at end — strips quotes and assigns to focus", () => {
    const result = parseReviewInvocation(['--agent', "codex", '"check error handling"'], AGENTS);
    assert.deepStrictEqual(result, { agent: "codex", focus: "check error handling" });
  });

  it("quoted focus with one positional path — path + focus", () => {
    const result = parseReviewInvocation(['src/lib.ts', '"fix the bug"'], AGENTS);
    assert.deepStrictEqual(result, { path: "src/lib.ts", focus: "fix the bug" });
  });

  it("quoted focus with agent + path positionals — agent + path + focus", () => {
    const result = parseReviewInvocation(['codex', 'src/lib.ts', '"review types"'], AGENTS);
    assert.deepStrictEqual(result, { agent: "codex", path: "src/lib.ts", focus: "review types" });
  });

  it("more than two positionals → error", () => {
    assert.throws(
      () => parseReviewInvocation(["a", "b", "c"], AGENTS),
      (err: Error) => err.message.includes("Expected 0-2 positionals"),
    );
  });

  it("--agent flag requires a value — error when missing", () => {
    assert.throws(
      () => parseReviewInvocation(["--agent"], AGENTS),
      (err: Error) => err.message.includes("--agent flag requires a value"),
    );
  });

  it("--path flag requires a value — error when missing", () => {
    assert.throws(
      () => parseReviewInvocation(["--path"], AGENTS),
      (err: Error) => err.message.includes("--path flag requires a value"),
    );
  });

  // Disambiguation case: arg "codex" in installedAgents AND there is a file literally named "codex"
  it("ambiguity: arg 'codex' matches agent → returns agent='codex'", () => {
    const result = parseReviewInvocation(["codex"], AGENTS);
    assert.deepStrictEqual(result, { agent: "codex" });
  });

  it("ambiguity: user can force path with --path flag", () => {
    const result = parseReviewInvocation(["--path", "codex"], AGENTS);
    assert.deepStrictEqual(result, { path: "codex" });
  });

  it("ambiguity: --agent + --path both explicit — neither is ambiguous", () => {
    const result = parseReviewInvocation(["--agent", "codex", "--path", "codex"], AGENTS);
    assert.deepStrictEqual(result, { agent: "codex", path: "codex" });
  });

  it("--path with positional agent — positional must match installed agents", () => {
    const result = parseReviewInvocation(["--path", "src/lib.ts", "aider"], AGENTS);
    assert.deepStrictEqual(result, { agent: "aider", path: "src/lib.ts" });
  });

  it("--path with positional that is not an agent → error", () => {
    assert.throws(
      () => parseReviewInvocation(["--path", "src/lib.ts", "notanagent"], AGENTS),
      (err: Error) => err.message.includes("Expected positional to be an agent id"),
    );
  });

  it("--agent with multiple positionals → error", () => {
    assert.throws(
      () => parseReviewInvocation(["--agent", "codex", "a", "b"], AGENTS),
      (err: Error) => err.message.includes("expected at most 1 positional path"),
    );
  });

  it("focus only — quoted string with no other positionals or flags", () => {
    const result = parseReviewInvocation(['"just a focus"'], AGENTS);
    assert.deepStrictEqual(result, { focus: "just a focus" });
  });

  it("--scope=cwd sets forceCwdScope=true", () => {
    const result = parseReviewInvocation(["--scope=cwd"], AGENTS);
    assert.deepStrictEqual(result, { forceCwdScope: true });
  });

  it("--scope cwd (space form) sets forceCwdScope=true", () => {
    const result = parseReviewInvocation(["--scope", "cwd"], AGENTS);
    assert.deepStrictEqual(result, { forceCwdScope: true });
  });

  it("--scope=repo throws with clear message", () => {
    assert.throws(
      () => parseReviewInvocation(["--scope=repo"], AGENTS),
      /only "cwd" is a valid --scope value/,
    );
  });

  it("--scope=cwd combined with --agent codex — both set", () => {
    const result = parseReviewInvocation(["--scope=cwd", "--agent", "codex"], AGENTS);
    assert.deepStrictEqual(result, { agent: "codex", forceCwdScope: true });
  });

  it("--scope=cwd combined with positional path — both fields set", () => {
    const result = parseReviewInvocation(["--scope=cwd", "myfile.ts"], AGENTS);
    assert.deepStrictEqual(result, { path: "myfile.ts", forceCwdScope: true });
  });
});
