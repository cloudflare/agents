#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

export function createCli(argv = process.argv) {
  return yargs(hideBin(argv))
    .scriptName("agents")
    .usage("$0 <command> [options]")
    .command(
      ["init", "create"],
      "Initialize an agents project",
      (cmd) => cmd,
      async () => {
        console.log("agents init: not implemented yet");
        process.exit(0);
      }
    )
    .command(
      "dev",
      "Start development server",
      (cmd) => cmd,
      async () => {
        console.log("agents dev: not implemented yet");
        process.exit(0);
      }
    )
    .command(
      "deploy",
      "Deploy agents to Cloudflare",
      (cmd) => cmd,
      async () => {
        console.log("agents deploy: not implemented yet");
        process.exit(0);
      }
    )
    .command(
      "mcp",
      "The agents mcp server",
      (cmd) => cmd,
      async () => {
        console.log("agents mcp: not implemented yet");
        process.exit(0);
      }
    )
    .demandCommand(1, "Please provide a command")
    .strict()
    .help();
}

// Run CLI if this is the main module
const __filename = fileURLToPath(import.meta.url);

// Check if this file was run directly (not imported)
if (
  process.argv[1] &&
  fileURLToPath(new URL(process.argv[1], "file://")) === __filename
) {
  void createCli().parse();
}
