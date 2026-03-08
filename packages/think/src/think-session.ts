/**
 * ThinkSession — a SubAgent base class for fully-featured chat sessions.
 *
 * Designed to be spawned by a parent Agent (via `withSubAgents`) as an
 * isolated conversation thread. Each instance gets its own SQLite storage
 * and runs the full chat lifecycle:
 *   store user message → assemble context → call LLM → stream events → persist response
 *
 * Uses SessionManager for message persistence, giving you branching and
 * compaction support for free.
 *
 * Override points:
 *   - getModel()         — return the LanguageModel to use
 *   - getSystemPrompt()  — return the system prompt
 *   - getTools()         — return the ToolSet for the agentic loop
 *   - getMaxSteps()      — max tool-call rounds per turn (default: 10)
 *   - assembleContext()   — customize context assembly from this.messages
 *   - onChatMessage()    — full control over inference (override the agentic loop)
 *   - onChatError()      — customize error handling
 *
 * Production features:
 *   - Abort/cancel support via AbortSignal
 *   - Error handling with partial message persistence
 *   - Message sanitization (strips OpenAI ephemeral metadata)
 *   - Row size enforcement (compacts large tool outputs)
 *   - Configurable storage bounds (maxPersistedMessages)
 *   - Incremental persistence (skips unchanged messages)
 *   - Richer input (accepts UIMessage or string)
 *
 * @experimental Requires the `"experimental"` compatibility flag.
 *
 * @example
 * ```typescript
 * import { ThinkSession } from "@cloudflare/think/think-session";
 * import { createWorkersAI } from "workers-ai-provider";
 * import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
 * import { Workspace } from "agents/experimental/workspace";
 *
 * export class ChatSession extends ThinkSession<Env> {
 *   workspace = new Workspace(this);
 *
 *   getModel() {
 *     return createWorkersAI({ binding: this.env.AI })("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
 *   }
 *
 *   getTools() {
 *     return createWorkspaceTools(this.workspace);
 *   }
 * }
 * ```
 */

import type {
  LanguageModel,
  ModelMessage,
  ProviderMetadata,
  ReasoningUIPart,
  ToolSet,
  UIMessage
} from "ai";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText
} from "ai";
import { SubAgent } from "agents/experimental/subagent";
import { SessionManager } from "./session/index";
import type { Session } from "./session/index";
import { applyChunkToParts } from "./message-builder";
import type { StreamChunkData } from "./message-builder";

export type { Session } from "./session/index";

/** Shared encoder for UTF-8 byte length measurement */
const textEncoder = new TextEncoder();

/**
 * Callback interface for streaming chat events from a ThinkSession.
 *
 * Designed to work across the sub-agent RPC boundary — implement as
 * an RpcTarget in the parent agent and pass to `chat()`.
 *
 * Methods may return a Promise for async RPC callbacks.
 */
export interface StreamCallback {
  /** Called for each UIMessageChunk event during streaming. */
  onEvent(json: string): void | Promise<void>;
  /** Called when the stream completes successfully (not called on abort). */
  onDone(): void | Promise<void>;
  /** Called when an error occurs during streaming. */
  onError?(error: string): void | Promise<void>;
}

/**
 * Minimal interface for the result of `onChatMessage()`.
 * Must provide a `toUIMessageStream()` method that returns an
 * async-iterable stream of UI message chunks.
 *
 * The AI SDK's `streamText()` result satisfies this interface.
 */
export interface StreamableResult {
  toUIMessageStream(): AsyncIterable<unknown>;
}

/**
 * Options for a chat turn.
 */
export interface ChatOptions {
  /** AbortSignal — fires when the caller wants to cancel the turn. */
  signal?: AbortSignal;
}

/**
 * Options passed to the onChatMessage handler.
 */
export interface ChatMessageOptions {
  /** AbortSignal for cancelling the request */
  signal?: AbortSignal;
}

/**
 * A SubAgent-based chat session with an agentic loop, message persistence,
 * and streaming. Designed to be spawned per-conversation by a parent Agent.
 *
 * @experimental Requires the `"experimental"` compatibility flag.
 */
export class ThinkSession<
  Env extends Cloudflare.Env = Cloudflare.Env
> extends SubAgent<Env> {
  /** Session manager — persistence layer with branching and compaction. */
  sessions!: SessionManager;

  /** In-memory messages for the current conversation. Authoritative after load. */
  messages: UIMessage[] = [];

  /**
   * Maximum number of messages to keep in storage per session.
   * When exceeded, oldest messages are deleted after each persist.
   * Set to `undefined` (default) for no limit.
   *
   * This controls storage only — it does not affect what's sent to the LLM.
   * Use `pruneMessages()` in `assembleContext()` to control LLM context.
   */
  maxPersistedMessages: number | undefined = undefined;

  /**
   * Cache of last-persisted JSON for each message ID.
   * Used for incremental persistence: skip SQL writes for unchanged messages.
   * @internal
   */
  private _persistedMessageCache: Map<string, string> = new Map();

  private _sessionId: string | null = null;

  /** Maximum serialized message size before compaction (bytes). 1.8MB with headroom below SQLite's 2MB limit. */
  private static ROW_MAX_BYTES = 1_800_000;

  /** Measure UTF-8 byte length of a string. */
  private static _byteLength(s: string): number {
    return textEncoder.encode(s).byteLength;
  }

  onStart() {
    this.sessions = new SessionManager(this);
    const existing = this.sessions.list();
    if (existing.length > 0) {
      this._sessionId = existing[0].id;
      this.messages = this.sessions.getHistory(this._sessionId);
      this._rebuildPersistenceCache();
    }
  }

  // ── Override points ──────────────────────────────────────────────

  /**
   * Return the language model to use for inference.
   * Must be overridden by subclasses.
   */
  getModel(): LanguageModel {
    throw new Error("Override getModel() to return a LanguageModel.");
  }

  /**
   * Return the system prompt for the assistant.
   * Override to customize instructions.
   */
  getSystemPrompt(): string {
    return "You are a helpful assistant.";
  }

  /**
   * Return the tools available to the assistant.
   * Override to provide workspace tools, custom tools, etc.
   */
  getTools(): ToolSet {
    return {};
  }

  /**
   * Return the maximum number of tool-call steps per turn.
   */
  getMaxSteps(): number {
    return 10;
  }

  /**
   * Assemble the model messages from the current conversation history.
   * Override to customize context assembly (e.g. inject memory,
   * project context, or apply compaction).
   */
  async assembleContext(): Promise<ModelMessage[]> {
    return pruneMessages({
      messages: await convertToModelMessages(this.messages),
      toolCalls: "before-last-2-messages"
    });
  }

  /**
   * Handle a chat turn and return the streaming result.
   *
   * The default implementation runs the agentic loop:
   * 1. Assemble context from `this.messages`
   * 2. Call `streamText` with the model, system prompt, tools, and step limit
   *
   * Override for full control over inference (e.g. different models per turn,
   * RAG pipelines, routing to specialized sub-agents, etc.).
   *
   * When this is called, `this.messages` already contains the user's
   * latest message persisted to the current session.
   *
   * @returns A result with `toUIMessageStream()` — AI SDK's `streamText()`
   *          return value satisfies this interface.
   */
  async onChatMessage(options?: ChatMessageOptions): Promise<StreamableResult> {
    return streamText({
      model: this.getModel(),
      system: this.getSystemPrompt(),
      messages: await this.assembleContext(),
      tools: this.getTools(),
      stopWhen: stepCountIs(this.getMaxSteps()),
      abortSignal: options?.signal
    });
  }

  /**
   * Handle an error that occurred during a chat turn.
   * Override to customize error handling (e.g. logging, metrics).
   *
   * @param error The error that occurred
   * @returns The error (or a wrapped version) to propagate
   */
  onChatError(error: unknown): unknown {
    return error;
  }

  // ── Chat ─────────────────────────────────────────────────────────

  /**
   * Run a chat turn: persist the user message, run the agentic loop,
   * stream UIMessageChunk events via callback, and persist the
   * assistant's response.
   *
   * On error or abort, the partial assistant message is still persisted
   * so the user doesn't lose context.
   *
   * @param userMessage The user's message (string or UIMessage for multi-modal)
   * @param callback Streaming callback (typically an RpcTarget from the parent)
   * @param options Optional chat options (e.g. AbortSignal)
   */
  async chat(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    options?: ChatOptions
  ): Promise<void> {
    // Ensure a session exists
    if (!this._sessionId) {
      const session = this.sessions.create("default");
      this._sessionId = session.id;
    }

    // Persist user message
    const userMsg: UIMessage =
      typeof userMessage === "string"
        ? {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: userMessage }]
          }
        : userMessage;

    this.sessions.append(this._sessionId, userMsg);
    this.messages = this.sessions.getHistory(this._sessionId);

    // Build assistant message from stream chunks
    const assistantMsg: UIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: []
    };

    try {
      // Run the agentic loop (or custom override)
      const result = await this.onChatMessage({ signal: options?.signal });

      // Stream UIMessageChunk events via callback
      let aborted = false;
      for await (const chunk of result.toUIMessageStream()) {
        if (options?.signal?.aborted) {
          aborted = true;
          break;
        }
        applyChunkToParts(
          assistantMsg.parts,
          chunk as unknown as StreamChunkData
        );
        await callback.onEvent(JSON.stringify(chunk));
      }

      // Persist assistant message (sanitized + size-enforced)
      this._persistAssistantMessage(assistantMsg);

      // Only signal completion if not aborted
      if (!aborted) {
        await callback.onDone();
      }
    } catch (error) {
      // Persist partial assistant message so context isn't lost
      if (assistantMsg.parts.length > 0) {
        this._persistAssistantMessage(assistantMsg);
      }

      const wrapped = this.onChatError(error);
      const errorMessage =
        wrapped instanceof Error ? wrapped.message : String(wrapped);

      if (callback.onError) {
        await callback.onError(errorMessage);
      } else {
        // Re-throw if no error callback — caller must handle it
        throw wrapped;
      }
    }
  }

  // ── Message access ───────────────────────────────────────────────

  /**
   * Get the current session info, or null if no session exists yet.
   */
  getSession(): Session | null {
    if (!this._sessionId) return null;
    return this.sessions.get(this._sessionId);
  }

  /**
   * Get the conversation history as UIMessage[].
   */
  getHistory(): UIMessage[] {
    if (!this._sessionId) return [];
    return this.sessions.getHistory(this._sessionId);
  }

  /**
   * Get the total message count for this session.
   */
  getMessageCount(): number {
    if (!this._sessionId) return 0;
    return this.sessions.getMessageCount(this._sessionId);
  }

  /**
   * Clear all messages from this session (preserves the session itself).
   */
  clearMessages(): void {
    if (!this._sessionId) return;
    this.sessions.clearMessages(this._sessionId);
    this.messages = [];
    this._persistedMessageCache.clear();
  }

  // ── Persistence internals ────────────────────────────────────────

  /**
   * Persist an assistant message with sanitization, size enforcement,
   * and incremental persistence.
   * @internal
   */
  private _persistAssistantMessage(msg: UIMessage): void {
    if (!this._sessionId) return;

    const sanitized = ThinkSession._sanitizeMessage(msg);
    const safe = ThinkSession._enforceRowSizeLimit(sanitized);
    const json = JSON.stringify(safe);

    // Skip SQL write if unchanged (incremental persistence)
    if (this._persistedMessageCache.get(safe.id) !== json) {
      this.sessions.upsert(this._sessionId, safe);
      this._persistedMessageCache.set(safe.id, json);
    }

    // Enforce storage bounds
    if (this.maxPersistedMessages != null) {
      this._enforceMaxPersistedMessages();
    }

    this.messages = this.sessions.getHistory(this._sessionId);
  }

  /**
   * Rebuild the persistence cache from current messages.
   * Called on startup to enable incremental persistence.
   * @internal
   */
  private _rebuildPersistenceCache(): void {
    this._persistedMessageCache.clear();
    for (const msg of this.messages) {
      this._persistedMessageCache.set(msg.id, JSON.stringify(msg));
    }
  }

  /**
   * Delete oldest messages on the current branch when count exceeds
   * maxPersistedMessages. Uses path-based count (not total across all
   * branches) and individual deletes to preserve branch structure.
   * @internal
   */
  private _enforceMaxPersistedMessages(): void {
    if (this.maxPersistedMessages == null || !this._sessionId) return;

    // Use current branch history, not total message count across all branches
    const history = this.sessions.getHistory(this._sessionId);
    if (history.length <= this.maxPersistedMessages) return;

    const excess = history.length - this.maxPersistedMessages;
    const toRemove = history.slice(0, excess);

    // Delete individual messages — preserves branch structure
    this.sessions.deleteMessages(toRemove.map((m) => m.id));
    for (const msg of toRemove) {
      this._persistedMessageCache.delete(msg.id);
    }
  }

  // ── Message sanitization ─────────────────────────────────────────

  /**
   * Sanitize a message for persistence by removing ephemeral provider-specific
   * data that should not be stored or sent back in subsequent requests.
   *
   * 1. Strips OpenAI ephemeral fields (itemId, reasoningEncryptedContent)
   * 2. Filters truly empty reasoning parts (no text, no remaining providerMetadata)
   *
   * @internal
   */
  static _sanitizeMessage(message: UIMessage): UIMessage {
    // Strip OpenAI-specific ephemeral data from all parts
    const strippedParts = message.parts.map((part) => {
      let sanitizedPart = part;

      if (
        "providerMetadata" in sanitizedPart &&
        sanitizedPart.providerMetadata &&
        typeof sanitizedPart.providerMetadata === "object" &&
        "openai" in sanitizedPart.providerMetadata
      ) {
        sanitizedPart = ThinkSession._stripOpenAIMetadata(
          sanitizedPart,
          "providerMetadata"
        );
      }

      if (
        "callProviderMetadata" in sanitizedPart &&
        sanitizedPart.callProviderMetadata &&
        typeof sanitizedPart.callProviderMetadata === "object" &&
        "openai" in sanitizedPart.callProviderMetadata
      ) {
        sanitizedPart = ThinkSession._stripOpenAIMetadata(
          sanitizedPart,
          "callProviderMetadata"
        );
      }

      return sanitizedPart;
    }) as UIMessage["parts"];

    // Filter out reasoning parts that are truly empty
    const sanitizedParts = strippedParts.filter((part) => {
      if (part.type === "reasoning") {
        const reasoningPart = part as ReasoningUIPart;
        if (!reasoningPart.text || reasoningPart.text.trim() === "") {
          if (
            "providerMetadata" in reasoningPart &&
            reasoningPart.providerMetadata &&
            typeof reasoningPart.providerMetadata === "object" &&
            Object.keys(reasoningPart.providerMetadata).length > 0
          ) {
            return true;
          }
          return false;
        }
      }
      return true;
    });

    return { ...message, parts: sanitizedParts };
  }

  /**
   * Strip OpenAI-specific ephemeral fields from a metadata object.
   * @internal
   */
  private static _stripOpenAIMetadata<T extends UIMessage["parts"][number]>(
    part: T,
    metadataKey: "providerMetadata" | "callProviderMetadata"
  ): T {
    const metadata = (part as Record<string, unknown>)[metadataKey] as {
      openai?: Record<string, unknown>;
      [key: string]: unknown;
    };

    if (!metadata?.openai) return part;

    const {
      itemId: _itemId,
      reasoningEncryptedContent: _rec,
      ...restOpenai
    } = metadata.openai;

    const hasOtherOpenaiFields = Object.keys(restOpenai).length > 0;
    const { openai: _openai, ...restMetadata } = metadata;

    let newMetadata: ProviderMetadata | undefined;
    if (hasOtherOpenaiFields) {
      newMetadata = { ...restMetadata, openai: restOpenai } as ProviderMetadata;
    } else if (Object.keys(restMetadata).length > 0) {
      newMetadata = restMetadata as ProviderMetadata;
    }

    const { [metadataKey]: _oldMeta, ...restPart } = part as Record<
      string,
      unknown
    >;

    if (newMetadata) {
      return { ...restPart, [metadataKey]: newMetadata } as T;
    }
    return restPart as T;
  }

  // ── Row size enforcement ─────────────────────────────────────────

  /**
   * Enforce SQLite row size limits by compacting tool outputs and text parts
   * when a serialized message exceeds the safety threshold (1.8MB).
   *
   * Compaction strategy:
   * 1. Compact tool outputs over 1KB (replace with summary)
   * 2. If still too big, truncate text parts from oldest to newest
   *
   * @internal
   */
  static _enforceRowSizeLimit(message: UIMessage): UIMessage {
    let json = JSON.stringify(message);
    let size = ThinkSession._byteLength(json);
    if (size <= ThinkSession.ROW_MAX_BYTES) return message;

    if (message.role !== "assistant") {
      return ThinkSession._truncateTextParts(message);
    }

    // Pass 1: compact tool outputs
    const compactedParts = message.parts.map((part) => {
      if (
        "output" in part &&
        "toolCallId" in part &&
        "state" in part &&
        part.state === "output-available"
      ) {
        const outputJson = JSON.stringify((part as { output: unknown }).output);
        if (outputJson.length > 1000) {
          return {
            ...part,
            output:
              "This tool output was too large to persist in storage " +
              `(${outputJson.length} bytes). ` +
              "If the user asks about this data, suggest re-running the tool. " +
              `Preview: ${outputJson.slice(0, 500)}...`
          };
        }
      }
      return part;
    }) as UIMessage["parts"];

    let result: UIMessage = { ...message, parts: compactedParts };

    json = JSON.stringify(result);
    size = ThinkSession._byteLength(json);
    if (size <= ThinkSession.ROW_MAX_BYTES) return result;

    // Pass 2: truncate text parts
    return ThinkSession._truncateTextParts(result);
  }

  /**
   * Truncate text parts to fit within the row size limit.
   * @internal
   */
  private static _truncateTextParts(message: UIMessage): UIMessage {
    const parts = [...message.parts];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.type === "text" && "text" in part) {
        const text = (part as { text: string }).text;
        if (text.length > 1000) {
          parts[i] = {
            ...part,
            text:
              `[Text truncated for storage (${text.length} chars). ` +
              `First 500 chars: ${text.slice(0, 500)}...]`
          } as UIMessage["parts"][number];

          const candidate = { ...message, parts };
          if (
            ThinkSession._byteLength(JSON.stringify(candidate)) <=
            ThinkSession.ROW_MAX_BYTES
          ) {
            break;
          }
        }
      }
    }

    return { ...message, parts };
  }
}
