#!/usr/bin/env node
// Single binary, two modes:
//
//   1. Transformer mode — when spawned by the hydra-acp daemon, the env
//      var HYDRA_ACP_TRANSFORMER_NAME is set. We connect to the daemon
//      over WSS, register intercepts, and run the reviewer's hook loop
//      until shutdown.
//
//   2. CLI mode — invoked from the user's shell (typically via
//      `hydra-acp review ...` which execs us per the git-style
//      subcommand fallback). We parse argv and dispatch to the
//      user-facing commands defined in cli.ts.

import { runTransformer } from "@hydra-acp/transformer";
import { runCli } from "./cli.js";
import { reviewerDefinition } from "./reviewer.js";

async function main(): Promise<void> {
  if (process.env.HYDRA_ACP_TRANSFORMER_NAME) {
    await runTransformer(reviewerDefinition);
    return;
  }
  runCli(process.argv.slice(2));
}

main().catch((err) => {
  process.stderr.write(`hydra-acp-reviewer: ${(err as Error).message}\n`);
  process.exit(1);
});
