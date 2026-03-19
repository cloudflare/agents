#!/usr/bin/env node
/**
 * think — Terminal coding agent.
 *
 * Config: ~/.think/config.json
 * Usage:
 *   think                                  # interactive TUI
 *   think -p "explain this code"           # print mode
 *   think --mode json "explain this"       # JSON event stream
 *   think --provider anthropic --model claude-opus-4-6 --save
 *   echo "analyze" | think -p
 */

import { loadConfig, applyCliArgs, readOpenCodeToken, resolveGithubToken } from "./local/config.js";
import { runPrint } from "./modes/print.js";
import { runInteractive } from "./modes/interactive.js";

async function main() {
  const base = loadConfig();
  const parsed = applyCliArgs(base, process.argv.slice(2));

  // Auto-resolve API key: config → env → opencode auth
  if (!parsed.config.apiKey) {
    parsed.config.apiKey =
      process.env.ANTHROPIC_API_KEY ??
      process.env.OPENAI_API_KEY ??
      readOpenCodeToken();
  }

  if (!parsed.config.apiKey) {
    console.error("No API key found. Set in ~/.think/config.json, env, or login to opencode.");
    process.exit(1);
  }

  // Auto-resolve GitHub token: config → env → gh CLI auth
  if (!parsed.config.githubToken) {
    parsed.config.githubToken = resolveGithubToken(parsed.config);
  }

  // Auto-detect piped stdin
  if (!parsed.print && !process.stdin.isTTY && !parsed.message) {
    parsed.print = true;
  }

  if (parsed.print) {
    await runPrint({
      config: parsed.config,
      mode: parsed.mode,
      message: parsed.message
    });
  } else {
    await runInteractive(parsed.config);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
