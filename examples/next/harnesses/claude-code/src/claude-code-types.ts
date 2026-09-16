/**
 * The Claude Code vocabulary, type-only and dependency-free.
 *
 * This half is split out from `./claude-code-protocol.ts` because the daemon
 * inside the container imports it with a relative type-only import, and the
 * daemon is a plain Node project: it must not pull the Workers half of the
 * shared harness (`cloudflare:workers`, `Container`) into its program. The
 * one import here reaches the zero-dependency wire module only.
 */
import type { HarnessDeliverRow } from "@cloudflare/agents-next-harness/protocol";

/**
 * The shared `JsonValue`. The zero-dependency wire entry does not re-export
 * it by name, and the package root cannot be imported here (it reaches the
 * Workers half), so it is named through the one field that already has it.
 */
type JsonValue = HarnessDeliverRow["payload"];

/**
 * What the engine is configured with. Opaque to the wire and to the shared
 * runtime: it travels as `HarnessEngineSpec.options` and the engine parses
 * it inside the container.
 */
export type ClaudeCodeOptions = {
  readonly model: string;
  /**
   * `"dontAsk"` and `"bypassPermissions"` are deliberately absent: a policy
   * that asks needs a mode that can ask, and the daemon refuses the others.
   */
  readonly permissionMode?: "default" | "acceptEdits" | "plan";
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  /** Tools that raise a permission request instead of running unprompted. */
  readonly ask?: readonly string[];
  /** Run once in `/workspace` before the first turn on a fresh container. */
  readonly setup?: readonly string[];
  readonly budget?: { readonly maxUsd: number };
  readonly maxTurns?: number;
  /**
   * Tools the Durable Object runs on the engine's behalf. Each call parks as
   * a `tool` request and is answered with `reply()`.
   */
  readonly tools?: {
    readonly [name: string]: {
      readonly description: string;
      /** JSON Schema for the input, `$defs` inlined. */
      readonly inputSchema: JsonValue;
    };
  };
};

/** Everything the engine reports that the core vocabulary has no word for. */
export type ClaudeCodeEvent =
  | {
      readonly type: "engine_init";
      readonly sessionId: string;
      readonly model: string;
      readonly tools: readonly string[];
    }
  /** Signal only: the text of a thinking block rides `message_end`. */
  | { readonly type: "thinking"; readonly messageId: string }
  | {
      readonly type: "permission_denied";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly reason: string;
    }
  | {
      readonly type: "compacted";
      readonly trigger: "manual" | "auto";
      readonly preTokens: number;
    }
  | {
      readonly type: "subagent";
      readonly state: "started" | "progress" | "ended";
      readonly toolCallId: string;
    }
  | {
      readonly type: "rate_limit";
      readonly status: string;
      readonly resetsAt?: number;
    }
  | {
      readonly type: "retry";
      readonly attempt: number;
      readonly maxRetries: number;
      readonly errorStatus: number | null;
    }
  | { readonly type: "conversation_reset"; readonly newConversationId: string }
  /**
   * One batch of the engine's transcript mirror was dropped after the SDK's
   * own retries: the session survives, but the durable copy now has a hole
   * a later resume would have wanted.
   */
  | {
      readonly type: "mirror_error";
      readonly engineSessionId: string;
      readonly subpath: string | null;
      readonly message: string;
    }
  /** Forward compatibility: an unrecognised SDK message becomes this, never a drop. */
  | {
      readonly type: "engine_raw";
      readonly kind: string;
      readonly subtype: string | null;
      readonly body: JsonValue;
    };

export type ClaudeCodeProtocol = {
  event: ClaudeCodeEvent;
  /** Context appended to the transcript without starting a turn. */
  submit: { kind: "context"; payload: { text: string } };
  result: {
    readonly subtype: string;
    readonly duration_ms?: number;
    readonly num_turns?: number;
    readonly is_error?: boolean;
  };
};
