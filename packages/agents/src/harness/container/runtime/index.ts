/**
 * The harness daemon's Node runtime, for images that bring their own agent
 * CLI: serve the daemon core over HTTP and WebSockets, and describe a CLI
 * with `cliAdapter`. The harness installs the built-in presets (Claude Code,
 * Codex) itself; this entry is for everything else.
 *
 * Node only.
 *
 * @experimental The API may change before it stabilizes.
 */
export {
  serve,
  serveFromEnv,
  type DaemonServer,
  type ServeOptions
} from "./server";
export {
  cliAdapter,
  type CliAdapterOptions,
  type CliCommand,
  type CliParser,
  type CliState,
  type CliTurn,
  type CliUpdate
} from "./cli-adapter";
export { claudeCodeCli } from "./presets/claude-code";
export { codexCli } from "./presets/codex";
