/**
 * Claude Code as a CLI preset: `claude -p` with `stream-json` output, one
 * process per turn, resuming its own session by id. Transcripts live under
 * `~/.claude/projects`, which the adapter mirrors.
 *
 * Credentials come from the container's environment: `ANTHROPIC_API_KEY`,
 * and `ANTHROPIC_BASE_URL` to go through AI Gateway (where the gateway
 * token is the key).
 */

import type { JsonValue } from "../../protocol";
import type { CliAdapterOptions } from "../cli-adapter";
import { isJsonObject, stringsOf } from "../json";
import { ClaudeProjection, type SdkMessageLike } from "./claude-code-events";

/** Claude Code settings, from the harness's `defaults.options`. */
export type ClaudeCodeOptions = {
  readonly appendSystemPrompt?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly maxTurns?: number;
};

function parseOptions(value: JsonValue | undefined): ClaudeCodeOptions {
  if (!isJsonObject(value)) return {};
  const allowed = stringsOf(value.allowedTools);
  const disallowed = stringsOf(value.disallowedTools);
  return {
    ...(typeof value.appendSystemPrompt === "string"
      ? { appendSystemPrompt: value.appendSystemPrompt }
      : {}),
    ...(allowed ? { allowedTools: allowed } : {}),
    ...(disallowed ? { disallowedTools: disallowed } : {}),
    ...(typeof value.maxTurns === "number" ? { maxTurns: value.maxTurns } : {})
  };
}

function parseLine(text: string): SdkMessageLike | undefined {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return undefined;
  }
  // SAFETY: a stream-json line is an SDK message; `SdkMessageLike` names
  // only fields the projection checks before it uses them.
  return value as SdkMessageLike;
}

/** The Claude Code preset's description, for `cliAdapter`. */
export const claudeCodeCli: CliAdapterOptions = {
  id: "claude-code",
  stateDirs: [".claude/projects"],
  command(turn) {
    const options = parseOptions(turn.settings.options);
    const argv = [
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // The container is the sandbox.
      "--dangerously-skip-permissions"
    ];
    if (turn.settings.model) argv.push("--model", turn.settings.model);
    if (turn.state.sessionId) argv.push("--resume", turn.state.sessionId);
    if (options.appendSystemPrompt) {
      argv.push("--append-system-prompt", options.appendSystemPrompt);
    }
    if (options.allowedTools?.length) {
      argv.push("--allowedTools", options.allowedTools.join(","));
    }
    if (options.disallowedTools?.length) {
      argv.push("--disallowedTools", options.disallowedTools.join(","));
    }
    if (options.maxTurns !== undefined) {
      argv.push("--max-turns", String(options.maxTurns));
    }
    return { argv, stdin: turn.prompt, env: { DISABLE_AUTOUPDATER: "1" } };
  },
  parser(turn) {
    const projection = new ClaudeProjection();
    return {
      line(text) {
        const message = parseLine(text);
        if (!message) return {};
        return {
          events: projection.project(message, turn.operationId),
          ...(message.session_id
            ? { state: { sessionId: message.session_id } }
            : {}),
          ...(message.type === "result"
            ? { outcome: projection.outcome(message, false) }
            : {})
        };
      },
      end({ code, stderr }) {
        return {
          status: "unanswered",
          reason: `claude exited with ${code ?? "a signal"}: ${stderr.trim() || "no output"}`
        };
      }
    };
  }
};
