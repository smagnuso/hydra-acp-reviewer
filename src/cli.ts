import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "hydra-acp-reviewer — adversarial-but-honest code reviewer for hydra-acp",
      "",
      "Usage:",
      "  hydra-acp review --version     Show version",
      "  hydra-acp review --help        Show this help message",
      "  hydra-acp review --validate <path>  Validate a file or directory",
      "",
    ].join("\n"),
  );
}

function runValidate(pathArg: string | undefined): void {
  if (!pathArg) {
    process.stderr.write("hydra-acp-reviewer validate: requires a path argument\n");
    process.exit(2);
  }
  process.stdout.write(`validate: ${pathArg}\n`);
}

export function runCli(argv: readonly string[]): void {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`hydra-acp-reviewer ${readVersion()}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "validate" || sub === "--validate") {
    runValidate(sub === "--validate" ? rest[0] : rest[0]);
    return;
  }
  if (sub && sub.startsWith("-")) {
    process.stderr.write(`hydra-acp-reviewer: unknown option: ${sub}\n`);
    printHelp();
    process.exit(2);
  }
  if (sub) {
    process.stderr.write(`hydra-acp-reviewer: unknown subcommand: ${sub}\n`);
    printHelp();
    process.exit(2);
  }
  printHelp();
}
