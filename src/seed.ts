import { DEFAULT_RUBRIC } from "./rubric.js";

export interface SeedInput {
  rubric?: string;
  diff?: string;
  filePath?: string;
  fileContents?: string;
  focus?: string;
  touchedPaths?: string[];
  createdPaths?: Set<string>;
}

function composeSeed(input: SeedInput): string {
  const {
    rubric = DEFAULT_RUBRIC,
    diff,
    filePath,
    fileContents,
    focus,
    touchedPaths,
    createdPaths,
  } = input;

  const parts: string[] = [];

  // a. Header
  parts.push("# Review request");

  // b. Rubric
  parts.push(rubric);

  // c. Focus (if provided)
  if (focus) {
    parts.push("## Reviewer focus");
    parts.push(focus);
  }

  // d. Target section
  if (diff !== undefined && touchedPaths && touchedPaths.length > 0) {
    parts.push("## Diff (files touched by this session)");
    const bullets = touchedPaths.map((p) => {
      if (createdPaths && createdPaths.has(p))
      {
        return `- ${p} (created)`;
      }
      return `- ${p}`;
    });
    parts.push(bullets.join("\n"));
    parts.push(
      "Note: file deletions are not shown \u2014 the session diff endpoint does not represent them.",
    );
    parts.push("```diff");
    parts.push(diff);
    parts.push("```");
  } else if (diff !== undefined) {
    parts.push("## Diff");
    parts.push("```diff");
    parts.push(diff);
    parts.push("```");
  } else if (filePath && fileContents !== undefined) {
    parts.push(`## File: ${filePath}`);
    parts.push("```");
    parts.push(fileContents);
    parts.push("```");
  } else if (diff === undefined && !(filePath && fileContents !== undefined)) {
    throw new Error(
      "composeSeed requires either a diff or both filePath and fileContents",
    );
  }

  // e. Closing pointer
  parts.push("Begin your review now. Use recall_* tools if needed.");

  return parts.join("\n\n");
}

export { composeSeed };
