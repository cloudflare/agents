/**
 * The daemon's entrypoint, as the harness installs it in a container.
 *
 * - `CF_HARNESS_ADAPTER` picks the CLI: `claude-code`, `codex`, or `echo`
 *   (no model, for smoke tests).
 * - `CF_HARNESS_USER` (`uid:gid`), when set, runs the CLI as that user.
 *
 * For another CLI, build an entrypoint of your own with
 * `serveFromEnv(cliAdapter({ ... }))` from `agents/harness/container/runtime`.
 */

import { echoAdapter, type ContainerAdapter } from "../daemon-core";
import { cliAdapter, type CliAdapterOptions } from "./cli-adapter";
import { claudeCodeCli } from "./presets/claude-code";
import { codexCli } from "./presets/codex";
import { serveFromEnv } from "./server";

const clis: { readonly [name: string]: CliAdapterOptions } = {
  "claude-code": claudeCodeCli,
  codex: codexCli
};

function parseUser(
  value: string | undefined
): { readonly uid: number; readonly gid: number } | undefined {
  const match = value ? /^(\d+):(\d+)$/.exec(value) : null;
  return match ? { uid: Number(match[1]), gid: Number(match[2]) } : undefined;
}

const name = process.env.CF_HARNESS_ADAPTER ?? "claude-code";
const user = parseUser(process.env.CF_HARNESS_USER);
const cli = clis[name];
const adapter: ContainerAdapter | undefined =
  name === "echo"
    ? echoAdapter
    : cli
      ? cliAdapter({
          ...cli,
          // The CLI's user must reach its home, not under root's; each
          // session home starts as a copy of the agent's own, where setup
          // installed plugins, mods and settings.
          ...(user
            ? {
                user,
                homes: "/home/agent/.harness/sessions",
                skeleton: "/home/agent"
              }
            : {})
        })
      : undefined;
if (!adapter) {
  console.error(`harness-daemon: unknown CF_HARNESS_ADAPTER ${name}`);
  process.exit(1);
}
await serveFromEnv(adapter).catch((error: unknown) => {
  console.error(`harness-daemon: ${String(error)}`);
  process.exit(1);
});
