/**
 * Codex as a CLI preset: `codex exec --json`, one process per turn,
 * resuming its own thread with `codex exec resume <thread>`. Rollouts live
 * under `~/.codex/sessions`, which the adapter mirrors.
 *
 * Credentials come from the container's environment: `OPENAI_API_KEY`,
 * and `OPENAI_BASE_URL` to go through AI Gateway (where the gateway token
 * is the key). Codex does not read `OPENAI_BASE_URL` itself, so the preset
 * passes it as a model provider.
 */

import type {
  ContainerEvent,
  ContainerMessage,
  ContainerPart,
  JsonValue
} from "../../protocol";
import type { CliAdapterOptions } from "../cli-adapter";
import { isJsonObject, stringsOf } from "../json";

type Item = {
  readonly id?: string;
  readonly type?: string;
  readonly text?: string;
  readonly message?: string;
  readonly command?: string;
  readonly aggregated_output?: string;
  readonly exit_code?: number | null;
  readonly status?: string;
  readonly changes?: JsonValue;
  readonly server?: string;
  readonly tool?: string;
  readonly arguments?: JsonValue;
  readonly result?: JsonValue;
  readonly error?: JsonValue;
  readonly query?: string;
  readonly items?: JsonValue;
};

type CodexLine = {
  readonly type?: string;
  readonly thread_id?: string;
  readonly item?: Item;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
  readonly error?: { readonly message?: string };
  readonly message?: string;
};

function parseLine(text: string): CodexLine | undefined {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) return undefined;
  // SAFETY: a `codex exec --json` line is one of its events; `CodexLine`
  // names only optional fields the projection checks before use.
  return value as CodexLine;
}

function toolState(status: string | undefined): "running" | "done" | "error" {
  if (status === "completed") return "done";
  if (status === "failed" || status === "declined") return "error";
  return "running";
}

/** One item as a transcript part, or undefined for items that are not. */
function partOf(item: Item): ContainerPart | undefined {
  const id = item.id ?? "item";
  const state = toolState(item.status);
  switch (item.type) {
    case "agent_message":
      return { type: "text", text: item.text ?? "" };
    case "reasoning":
      return { type: "reasoning", text: item.text ?? "" };
    case "command_execution":
      return {
        type: "tool",
        toolCallId: id,
        toolName: "shell",
        input: { command: item.command ?? "" },
        state:
          state === "done" && item.exit_code !== 0 && item.exit_code != null
            ? "error"
            : state,
        ...(item.aggregated_output ? { output: item.aggregated_output } : {})
      };
    case "file_change":
      return {
        type: "tool",
        toolCallId: id,
        toolName: "file_change",
        input: item.changes ?? null,
        state
      };
    case "mcp_tool_call":
      return {
        type: "tool",
        toolCallId: id,
        toolName: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`,
        input: item.arguments ?? null,
        state,
        ...(item.result !== undefined || item.error !== undefined
          ? { output: item.result ?? item.error ?? null }
          : {})
      };
    case "web_search":
      return {
        type: "tool",
        toolCallId: id,
        toolName: "web_search",
        input: { query: item.query ?? "" },
        state
      };
    case "todo_list":
      return {
        type: "tool",
        toolCallId: id,
        toolName: "todo_list",
        input: item.items ?? null,
        state
      };
    default:
      return undefined;
  }
}

/** Codex settings, from the harness's `defaults.options`. */
export type CodexOptions = {
  /** Extra `-c key=value` config overrides. */
  readonly config?: readonly string[];
};

function parseOptions(value: JsonValue | undefined): CodexOptions {
  if (!isJsonObject(value)) return {};
  const config = stringsOf(value.config);
  return config ? { config } : {};
}

/** The Codex preset's description, for `cliAdapter`. */
export const codexCli: CliAdapterOptions = {
  id: "codex",
  stateDirs: [".codex/sessions"],
  command(turn) {
    const argv = ["codex", "exec"];
    if (turn.state.threadId) argv.push("resume", turn.state.threadId);
    argv.push(
      "--json",
      "--skip-git-repo-check",
      // The container is the sandbox.
      "--dangerously-bypass-approvals-and-sandbox"
    );
    const baseUrl = process.env.OPENAI_BASE_URL;
    if (baseUrl) {
      argv.push(
        "-c",
        "model_provider=gateway",
        "-c",
        `model_providers.gateway={name="AI Gateway",base_url=${JSON.stringify(baseUrl)},env_key="OPENAI_API_KEY",wire_api="responses"}`
      );
    }
    for (const config of parseOptions(turn.settings.options).config ?? []) {
      argv.push("-c", config);
    }
    if (turn.settings.model) argv.push("-m", turn.settings.model);
    // `-` reads the prompt from stdin.
    argv.push("-");
    return { argv, stdin: turn.prompt };
  },
  parser(turn) {
    // One assistant message per turn, its parts in item order.
    const messageId = `${turn.operationId}:assistant`;
    const createdAt = Date.now();
    const parts = new Map<string, ContainerPart>();
    let lastText = "";
    let failure: string | undefined;
    const message = (): ContainerEvent => {
      const value: ContainerMessage = {
        id: messageId,
        role: "assistant",
        parts: [...parts.values()],
        operationId: turn.operationId,
        createdAt
      };
      return { type: "message", message: value };
    };
    return {
      line(text) {
        const event = parseLine(text);
        if (!event) return {};
        switch (event.type) {
          case "thread.started":
            return event.thread_id
              ? { state: { threadId: event.thread_id } }
              : {};
          case "item.started":
          case "item.updated":
          case "item.completed": {
            const item = event.item;
            if (!item) return {};
            if (item.type === "error") {
              return {
                events: [
                  {
                    type: "log",
                    level: "warn",
                    message: item.message ?? "error"
                  }
                ]
              };
            }
            const part = partOf(item);
            if (!part) return {};
            parts.set(item.id ?? String(parts.size), part);
            if (part.type === "text" && event.type === "item.completed") {
              lastText = part.text;
            }
            return { events: [message()] };
          }
          case "turn.completed":
            return {
              events: [
                {
                  type: "usage",
                  ...(event.usage?.input_tokens === undefined
                    ? {}
                    : { inputTokens: event.usage.input_tokens }),
                  ...(event.usage?.output_tokens === undefined
                    ? {}
                    : { outputTokens: event.usage.output_tokens })
                }
              ],
              outcome: { status: "done", text: lastText }
            };
          case "turn.failed":
            return {
              outcome: {
                status: "unanswered",
                reason: event.error?.message ?? "turn failed"
              }
            };
          case "error":
            // Reconnect notices and the like; a fatal one ends in
            // `turn.failed` or a non-zero exit.
            failure = event.message;
            return {
              events: [
                {
                  type: "log",
                  level: "warn",
                  message: event.message ?? "error"
                }
              ]
            };
          default:
            return {};
        }
      },
      end({ code, stderr }) {
        return {
          status: "unanswered",
          reason: `codex exited with ${code ?? "a signal"}: ${failure ?? (stderr.trim() || "no output")}`
        };
      }
    };
  }
};
