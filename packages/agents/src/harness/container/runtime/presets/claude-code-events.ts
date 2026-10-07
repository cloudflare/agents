/**
 * Claude Code's `stream-json` output, projected into `ContainerEvent`s.
 * Each line is an Agent SDK message.
 *
 * Pure and SDK-free: it reads only the fields it needs, structurally, so it
 * can be tested with plain fixtures and survives fields it does not know. Subagent traffic (`parent_tool_use_id` set) is left out of the
 * transcript; the top-level tool call that started the subagent carries its
 * result.
 */

import type {
  ContainerEvent,
  ContainerMessage,
  ContainerOutcome,
  ContainerPart,
  JsonValue
} from "../../protocol";

type Block = {
  readonly type: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly is_error?: boolean;
};

/** The subset of an SDK message the projection reads. */
export type SdkMessageLike = {
  readonly type: string;
  readonly subtype?: string;
  readonly uuid?: string;
  readonly session_id?: string;
  readonly parent_tool_use_id?: string | null;
  readonly message?: {
    readonly id?: string;
    readonly content?: string | readonly Block[];
  };
  readonly event?: {
    readonly type: string;
    readonly message?: { readonly id?: string };
    readonly delta?: {
      readonly type: string;
      readonly text?: string;
      readonly thinking?: string;
    };
  };
  readonly result?: string;
  readonly is_error?: boolean;
  readonly errors?: readonly string[];
  readonly total_cost_usd?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
};

type Draft = {
  readonly id: string;
  readonly operationId: string | undefined;
  readonly createdAt: number;
  parts: ContainerPart[];
};

function json(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    // SAFETY: a JSON round trip yields plain JSON.
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function toolOutput(content: unknown): JsonValue {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((block: unknown) =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
          ? block.text
          : undefined
      )
      .filter((text): text is string => text !== undefined);
    if (texts.length === content.length) return texts.join("\n");
  }
  return json(content);
}

/** The projection state of one adapter session. */
export class ClaudeProjection {
  readonly #drafts = new Map<string, Draft>();
  readonly #toolOwners = new Map<string, string>();
  readonly #seen = new Set<string>();
  #streaming: string | undefined;
  #now: () => number;

  /**
   * @param now - The clock, for message timestamps.
   */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * The events one SDK message produces.
   *
   * @param message - The SDK message.
   * @param operationId - The operation it belongs to.
   * @returns The events, in order.
   */
  project(
    message: SdkMessageLike,
    operationId: string | undefined
  ): ContainerEvent[] {
    if (message.parent_tool_use_id) return [];
    switch (message.type) {
      case "stream_event":
        return this.#stream(message);
      case "assistant":
        return this.#assistant(message, operationId);
      case "user":
        return this.#toolResults(message);
      case "result":
        return this.#usage(message);
      default:
        return [];
    }
  }

  /**
   * How a turn ended, from its `result` message.
   *
   * @param message - The result message.
   * @param aborted - Whether the turn was interrupted.
   * @returns The outcome.
   */
  outcome(message: SdkMessageLike, aborted: boolean): ContainerOutcome {
    if (aborted) return { status: "unanswered", reason: "aborted" };
    if (message.subtype === "success" && message.is_error !== true) {
      return { status: "done", text: message.result ?? "" };
    }
    const detail = message.errors?.join("; ") || message.result;
    const subtype =
      message.subtype && message.subtype !== "success" ? message.subtype : "";
    return {
      status: "unanswered",
      reason: [subtype, detail].filter((part) => part).join(": ") || "error"
    };
  }

  #stream(message: SdkMessageLike): ContainerEvent[] {
    const event = message.event;
    if (!event) return [];
    if (event.type === "message_start") {
      this.#streaming = event.message?.id;
      return [];
    }
    const messageId = this.#streaming;
    if (event.type !== "content_block_delta" || !messageId || !event.delta) {
      return [];
    }
    if (event.delta.type === "text_delta" && event.delta.text) {
      return [{ type: "text-delta", messageId, delta: event.delta.text }];
    }
    if (event.delta.type === "thinking_delta" && event.delta.thinking) {
      return [
        { type: "reasoning-delta", messageId, delta: event.delta.thinking }
      ];
    }
    return [];
  }

  #assistant(
    message: SdkMessageLike,
    operationId: string | undefined
  ): ContainerEvent[] {
    const id = message.message?.id;
    const content = message.message?.content;
    if (!id || !Array.isArray(content)) return [];
    // The SDK delivers one content block per message, all under the API
    // message's id; a replayed SDK message (same uuid) adds nothing.
    if (message.uuid !== undefined) {
      if (this.#seen.has(message.uuid)) return [];
      this.#seen.add(message.uuid);
    }
    let draft = this.#drafts.get(id);
    if (!draft) {
      draft = { id, operationId, createdAt: this.#now(), parts: [] };
      this.#drafts.set(id, draft);
    }
    for (const block of content) {
      if (block.type === "text" && block.text) {
        draft.parts.push({ type: "text", text: block.text });
      } else if (block.type === "thinking" && block.thinking) {
        draft.parts.push({ type: "reasoning", text: block.thinking });
      } else if (block.type === "tool_use" && block.id) {
        draft.parts.push({
          type: "tool",
          toolCallId: block.id,
          toolName: block.name ?? "tool",
          input: json(block.input),
          state: "running"
        });
        this.#toolOwners.set(block.id, id);
      }
    }
    return [{ type: "message", message: this.#message(draft) }];
  }

  #toolResults(message: SdkMessageLike): ContainerEvent[] {
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];
    const changed = new Set<Draft>();
    for (const block of content) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const owner = this.#toolOwners.get(block.tool_use_id);
      const draft = owner === undefined ? undefined : this.#drafts.get(owner);
      if (!draft) continue;
      draft.parts = draft.parts.map((part) =>
        part.type === "tool" && part.toolCallId === block.tool_use_id
          ? {
              ...part,
              state: block.is_error ? "error" : "done",
              output: toolOutput(block.content)
            }
          : part
      );
      changed.add(draft);
    }
    return [...changed].map((draft) => ({
      type: "message",
      message: this.#message(draft)
    }));
  }

  #usage(message: SdkMessageLike): ContainerEvent[] {
    return [
      {
        type: "usage",
        ...(message.usage?.input_tokens === undefined
          ? {}
          : { inputTokens: message.usage.input_tokens }),
        ...(message.usage?.output_tokens === undefined
          ? {}
          : { outputTokens: message.usage.output_tokens }),
        ...(message.total_cost_usd === undefined
          ? {}
          : { costUsd: message.total_cost_usd })
      }
    ];
  }

  #message(draft: Draft): ContainerMessage {
    return {
      id: draft.id,
      role: "assistant",
      parts: [...draft.parts],
      ...(draft.operationId === undefined
        ? {}
        : { operationId: draft.operationId }),
      createdAt: draft.createdAt
    };
  }
}
