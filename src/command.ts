// Pure-function argv parser for /review commands.
// No process.cwd(), no fs, no network — fully testable in isolation.

export interface ReviewIntent {
  agent?: string;
  path?: string;
  focus?: string;
  forceCwdScope?: boolean;
}

/**
 * Parse a /review invocation into a ReviewIntent.
 *
 * Parsing rules (applied in order):
 *   1. Explicit --agent <id> and --path <p> flags win over positional interpretation.
 *      Remaining argv after flag extraction is treated as positionals.
 *   2. If the last positional starts and ends with `"`, strip quotes and assign to focus.
 *      Continue with remaining positionals.
 *   3. Zero positionals → intent has only what flags set (or is empty).
 *   4. One positional: if it matches any string in installedAgents → agent; else → path.
 *   5. Two positionals: first is agent (must match installedAgents), second is path.
 *   6. More than two positionals → error.
 */
export function parseReviewInvocation(
  argv: string[],
  installedAgents: string[],
): ReviewIntent {
  let flagAgent: string | undefined;
  let flagPath: string | undefined;
  let forceCwdScope = false;

  const parseScopeValue = (v: string): void => {
    if (v !== "cwd")
    {
      throw new Error(
        `only "cwd" is a valid --scope value; got "${v}"`,
      );
    }
    forceCwdScope = true;
  };

  // Step 1: extract --agent, --path, --scope flags
  const remaining: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--agent") {
      if (i + 1 >= argv.length) {
        throw new Error(
          '--agent flag requires a value; expected: --agent <agent-id>',
        );
      }
      flagAgent = argv[i + 1]!;
      i++;
    } else if (arg === "--path") {
      if (i + 1 >= argv.length) {
        throw new Error(
          '--path flag requires a value; expected: --path <file-or-dir>',
        );
      }
      flagPath = argv[i + 1]!;
      i++;
    } else if (arg === "--scope") {
      if (i + 1 >= argv.length) {
        throw new Error(
          '--scope flag requires a value; expected: --scope cwd',
        );
      }
      parseScopeValue(argv[i + 1]!);
      i++;
    } else if (arg.startsWith("--scope=")) {
      parseScopeValue(arg.slice("--scope=".length));
    } else {
      remaining.push(arg);
    }
  }

  // Step 2: handle quoted focus on the last positional
  const positionals = remaining;
  let focus: string | undefined;
  if (positionals.length > 0) {
    const last = positionals[positionals.length - 1]!;
    if (last.startsWith('"') && last.endsWith('"') && last.length >= 2) {
      focus = last.slice(1, -1);
      positionals.pop();
    }
  }

  // Step 3: dispatch on positional count
  const intent: ReviewIntent = {};
  if (focus !== undefined) {
    intent.focus = focus;
  }
  if (flagAgent !== undefined) {
    intent.agent = flagAgent;
  }
  if (flagPath !== undefined) {
    intent.path = flagPath;
  }
  if (forceCwdScope) {
    intent.forceCwdScope = true;
  }

  // If both flags are set, positionals are not expected for agent/path
  // but we still apply positional rules only to remaining slots
  if (flagAgent === undefined && flagPath === undefined) {
    switch (positionals.length) {
      case 0:
        break;
      case 1: {
        const arg = positionals[0]!;
        if (installedAgents.includes(arg)) {
          intent.agent = arg;
        } else {
          intent.path = arg;
        }
        break;
      }
      case 2: {
        const first = positionals[0]!;
        const second = positionals[1]!;
        if (!installedAgents.includes(first)) {
          throw new Error(
            `Expected first positional to be an agent id (one of: ${installedAgents.join(", ")}), got "${first}"`,
          );
        }
        intent.agent = first;
        intent.path = second;
        break;
      }
      default:
        throw new Error(
          `Expected 0-2 positionals, got ${positionals.length}: ${positionals.map((p) => `"${p}"`).join(", ")}`,
        );
    }
  } else if (flagAgent !== undefined && flagPath === undefined) {
    switch (positionals.length) {
      case 0:
        break;
      case 1: {
        intent.path = positionals[0]!;
        break;
      }
      default:
        throw new Error(
          `With --agent set, expected at most 1 positional path, got ${positionals.length}: ${positionals.map((p) => `"${p}"`).join(", ")}`,
        );
    }
  } else if (flagAgent === undefined && flagPath !== undefined) {
    switch (positionals.length) {
      case 0:
        break;
      case 1: {
        const arg = positionals[0]!;
        if (!installedAgents.includes(arg)) {
          throw new Error(
            `Expected positional to be an agent id (one of: ${installedAgents.join(", ")}), got "${arg}"`,
          );
        }
        intent.agent = arg;
        break;
      }
      default:
        throw new Error(
          `With --path set, expected at most 1 positional agent, got ${positionals.length}: ${positionals.map((p) => `"${p}"`).join(", ")}`,
        );
    }
  }

  return intent;
}
