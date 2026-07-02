import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeSeed } from "../src/seed.js";
import { DEFAULT_RUBRIC } from "../src/rubric.js";

describe("composeSeed", () => {
  it("diff only", () => {
    const input = { diff: "diff --git a/foo.ts b/foo.ts\n+new line\n" };
    const result = composeSeed(input);
    // composeSeed joins all parts with "\n\n" (double newline / blank line)
    const expected = [
      "# Review request",
      DEFAULT_RUBRIC,
      "## Diff",
      "```diff",
      "diff --git a/foo.ts b/foo.ts\n+new line\n",
      "```",
      "Begin your review now. Use recall_* tools if needed.",
    ].join("\n\n");

    assert.strictEqual(result, expected);
  });

  it("file only", () => {
    const input = { filePath: "src/foo.ts", fileContents: "export const x = 1;" };
    const result = composeSeed(input);
    const expected = [
      "# Review request",
      DEFAULT_RUBRIC,
      "## File: src/foo.ts",
      "```",
      "export const x = 1;",
      "```",
      "Begin your review now. Use recall_* tools if needed.",
    ].join("\n\n");

    assert.strictEqual(result, expected);
  });

  it("diff + focus", () => {
    const input = {
      diff: "diff --git a/bar.ts b/bar.ts\n+change\n",
      focus: "Check the error handling in this function.",
    };
    const result = composeSeed(input);
    const expected = [
      "# Review request",
      DEFAULT_RUBRIC,
      "## Reviewer focus",
      "Check the error handling in this function.",
      "## Diff",
      "```diff",
      "diff --git a/bar.ts b/bar.ts\n+change\n",
      "```",
      "Begin your review now. Use recall_* tools if needed.",
    ].join("\n\n");

    assert.strictEqual(result, expected);
  });

  it("file + focus", () => {
    const input = {
      filePath: "lib/util.ts",
      fileContents: "function parse(s: string) {\n  return JSON.parse(s);\n}",
      focus: "Ensure null safety on the parse result.",
    };
    const result = composeSeed(input);
    const expected = [
      "# Review request",
      DEFAULT_RUBRIC,
      "## Reviewer focus",
      "Ensure null safety on the parse result.",
      "## File: lib/util.ts",
      "```",
      "function parse(s: string) {\n  return JSON.parse(s);\n}",
      "```",
      "Begin your review now. Use recall_* tools if needed.",
    ].join("\n\n");

    assert.strictEqual(result, expected);
  });

  it("neither diff nor file → throws", () => {
    assert.throws(
      () => composeSeed({}),
      (err: Error) => {
        assert.ok(
          err.message.includes("either a diff or both filePath and fileContents"),
          `Expected missing-input error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("custom rubric is used when provided", () => {
    const customRubric = "Be extra harsh on this one.";
    const input = { rubric: customRubric, diff: "some diff" };
    const result = composeSeed(input);

    assert.ok(result.startsWith("# Review request\n\n"));
    assert.ok(result.includes(customRubric));
    assert.strictEqual(result.includes(DEFAULT_RUBRIC), false);
  });

  it("touchedPaths branch: renders session-touched header, bullet list, deletion note", () => {
    const result = composeSeed({
      diff: "some rendered diff",
      touchedPaths: ["a.ts", "b.ts"],
      createdPaths: new Set(["b.ts"]),
    });
    assert.ok(result.includes("## Diff (files touched by this session)"));
    assert.ok(result.includes("- a.ts\n- b.ts (created)"));
    assert.ok(result.includes("file deletions are not shown"));
    assert.ok(result.includes("```diff"));
    assert.ok(result.includes("some rendered diff"));
    assert.strictEqual(result.includes("## Diff\n"), false);
  });

  it("touchedPaths preserves order from input", () => {
    const result = composeSeed({
      diff: "d",
      touchedPaths: ["zebra.ts", "alpha.ts"],
      createdPaths: new Set(),
    });
    const zIdx = result.indexOf("- zebra.ts");
    const aIdx = result.indexOf("- alpha.ts");
    assert.ok(zIdx > 0 && aIdx > 0 && zIdx < aIdx);
  });

  it("empty touchedPaths falls back to plain '## Diff' header", () => {
    const result = composeSeed({ diff: "d", touchedPaths: [] });
    assert.ok(result.includes("## Diff\n"));
    assert.strictEqual(result.includes("files touched by this session"), false);
  });
});
