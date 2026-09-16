/**
 * The typed Claude Code layer: one pure factory that names the engine the
 * image should run and hands it its options.
 *
 * The vocabulary itself lives in `./claude-code-types.ts`, which the daemon
 * imports too. No vendor name appears in the shared harness, and no engine
 * code appears here.
 */
import type { HarnessEngineSpec } from "@cloudflare/agents-next-harness/remote";
import type { JsonValue } from "@cloudflare/agents-next-harness";
import type {
  ClaudeCodeOptions,
  ClaudeCodeProtocol
} from "./claude-code-types";

export type {
  ClaudeCodeEvent,
  ClaudeCodeOptions,
  ClaudeCodeProtocol
} from "./claude-code-types";

/** Capabilities the Claude Code engine advertises to the client. */
const CAPABILITIES = new Set(["requests", "steer", "compact", "usage"]);

/** Name the engine the image should run, and how to configure it. */
export function claudeCode(
  options: ClaudeCodeOptions
): HarnessEngineSpec<ClaudeCodeProtocol> {
  return {
    id: "claude-code",
    // SAFETY: every field of ClaudeCodeOptions is JSON, and the engine
    // parses the same type on the other side of the wire.
    options: options as unknown as JsonValue,
    capabilities: CAPABILITIES
  };
}
