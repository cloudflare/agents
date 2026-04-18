/**
 * Think — an opinionated chat agent base class.
 *
 * Works as both a **top-level agent** (speaking the `cf_agent_chat_*`
 * WebSocket protocol to browser clients) and a **sub-agent** (called
 * via `chat()` over RPC from a parent agent).
 *
 * Each instance gets its own SQLite storage backed by Session — providing
 * tree-structured messages, context blocks, compaction, FTS5 search, and
 * multi-session support.
 *
 * Configuration overrides:
 *   - getModel()            — return the LanguageModel to use
 *   - getSystemPrompt()     — return the system prompt (fallback when no context blocks)
 *   - getTools()            — return the ToolSet for the agentic loop
 *   - maxSteps              — max tool-call rounds per turn (default: 10)
 *   - configureSession()    — add context blocks, compaction, search, skills
 *
 * Lifecycle hooks:
 *   - beforeTurn()          — inspect/override context, tools, model before inference
 *   - beforeToolCall()      — intercept tool calls (block, modify args, substitute result)
 *   - afterToolCall()       — inspect tool results after execution
 *   - onStepFinish()        — per-step callback (logging, analytics)
 *   - onChunk()             — per-chunk callback (streaming analytics)
 *   - onChatResponse()      — post-turn lifecycle hook (logging, chaining, analytics)
 *   - onChatError()         — customize error handling
 *
 * Production features:
 *   - WebSocket chat protocol (compatible with useAgentChat / useChat)
 *   - Sub-agent RPC streaming via StreamCallback
 *   - Session-backed storage with tree-structured messages
 *   - Context blocks with LLM-writable persistent memory
 *   - Non-destructive compaction (summaries replace ranges at read time)
 *   - FTS5 full-text search across conversation history
 *   - Abort/cancel support via AbortRegistry
 *   - Error handling with partial message persistence
 *   - Message sanitization (strips OpenAI ephemeral metadata)
 *   - Row size enforcement (compacts large tool outputs)
 *   - Resumable streams (replay on reconnect)
 *
 * @experimental The API surface may change before stabilizing.
 *
 * @example
 * ```typescript
 * import { Think } from "@cloudflare/think";
 * import { createWorkersAI } from "workers-ai-provider";
 *
 * export class MyAgent extends Think<Env> {
 *   getModel() {
 *     return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5");
 *   }
 *
 *   getSystemPrompt() {
 *     return "You are a helpful coding assistant.";
 *   }
 * }
 * ```
 *
 * @example With context blocks and self-updating memory
 * ```typescript
 * import { Think } from "@cloudflare/think";
 * import type { Session } from "@cloudflare/think";
 *
 * export class MemoryAgent extends Think<Env> {
 *   getModel() { ... }
 *
 *   configureSession(session: Session) {
 *     return session
 *       .withContext("soul", {
 *         provider: { get: async () => "You are a helpful coding assistant." }
 *       })
 *       .withContext("memory", {
 *         description: "Important facts learned during conversation.",
 *         maxTokens: 2000
 *       })
 *       .withCachedPrompt();
 *   }
 * }
 * ```
 */

import type {
  LanguageModel,
  ModelMessage,
  StreamTextOnChunkCallback,
  StreamTextOnStepFinishCallback,
  StreamTextOnToolCallFinishCallback,
  TextStreamPart,
  ToolSet,
  TypedToolCall,
  TypedToolResult,
  UIMessage
} from "ai";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText
} from "ai";

// Re-export AI SDK types that appear on Think's public lifecycle hooks
// so users can import them from a single place.
export type {
  StepResult,
  TextStreamPart,
  TypedToolCall,
  TypedToolResult
} from "ai";
import {
  Agent,
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext
} from "agents";
import type { Connection, WSMessage } from "agents";
import type { FiberContext, FiberRecoveryContext } from "agents";
import {
  sanitizeMessage,
  enforceRowSizeLimit,
  StreamAccumulator,
  CHAT_MESSAGE_TYPES,
  TurnQueue,
  ResumableStream,
  ContinuationState,
  createToolsFromClientSchemas,
  AbortRegistry,
  applyToolUpdate,
  toolResultUpdate,
  toolApprovalUpdate,
  parseProtocolMessage,
  applyChunkToParts
} from "agents/chat";
import type {
  StreamChunkData,
  ClientToolSchema,
  MessagePart
} from "agents/chat";
import { Session } from "agents/experimental/memory/session";
import { truncateOlderMessages } from "agents/experimental/memory/utils";
import { Workspace } from "@cloudflare/shell";
import { createWorkspaceTools } from "./tools/workspace";

export { Session } from "agents/experimental/memory/session";
export { Workspace } from "@cloudflare/shell";
export type { FiberContext, FiberRecoveryContext } from "agents";

// ── Wire protocol constants ────────────────────────────────────────
const MSG_CHAT_MESSAGES = CHAT_MESSAGE_TYPES.CHAT_MESSAGES;
const MSG_CHAT_RESPONSE = CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE;
const MSG_CHAT_CLEAR = CHAT_MESSAGE_TYPES.CHAT_CLEAR;
const MSG_STREAM_RESUMING = CHAT_MESSAGE_TYPES.STREAM_RESUMING;
const MSG_STREAM_RESUME_NONE = CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE;
const MSG_MESSAGE_UPDATED = CHAT_MESSAGE_TYPES.MESSAGE_UPDATED;

/**
 * Callback interface for streaming chat events from a Think sub-agent.
 *
 * Designed to work across the sub-agent RPC boundary — implement as
 * an RpcTarget in the parent agent and pass to `chat()`.
 */
export interface StreamCallback {
  onEvent(json: string): void | Promise<void>;
  onDone(): void | Promise<void>;
  onError?(error: string): void | Promise<void>;
}

/**
 * Minimal interface for the result of the inference loop.
 * The AI SDK's `streamText()` result satisfies this interface.
 */
export interface StreamableResult {
  toUIMessageStream(): AsyncIterable<unknown>;
}

/**
 * Options for a chat turn (sub-agent RPC entry point).
 */
export interface ChatOptions {
  signal?: AbortSignal;
  tools?: ToolSet;
}

/**
 * Result returned by `saveMessages()` and `continueLastTurn()`.
 */
export type SaveMessagesResult = {
  requestId: string;
  status: "completed" | "skipped";
};

/**
 * Context passed to `onChatRecovery` when an interrupted chat stream
 * is detected after DO restart.
 */
export type ChatRecoveryContext = {
  streamId: string;
  requestId: string;
  partialText: string;
  partialParts: MessagePart[];
  recoveryData: unknown | null;
  messages: UIMessage[];
  lastBody?: Record<string, unknown>;
  lastClientTools?: ClientToolSchema[];
  /**
   * Epoch milliseconds when the underlying fiber was started. Compare against
   * `Date.now()` to suppress continuations for turns that have been orphaned
   * too long to safely replay.
   */
  createdAt: number;
};

/**
 * Options returned from `onChatRecovery` to control recovery behavior.
 */
export type ChatRecoveryOptions = {
  persist?: boolean;
  continue?: boolean;
};

// ── Lifecycle hook types ────────────────────────────────────────

/**
 * A chat turn request. Built automatically by each entry path
 * (WebSocket, chat(), saveMessages, auto-continuation) and passed
 * to Think's inference loop.
 */
export interface TurnInput {
  signal?: AbortSignal;
  /** Extra tools from the caller (e.g. chat() options) — highest merge priority. */
  callerTools?: ToolSet;
  /** Client-provided tool schemas for dynamic tool registration. */
  clientTools?: ClientToolSchema[];
  /** Custom body fields from the client request. */
  body?: Record<string, unknown>;
  /** Whether this is a continuation turn (auto-continue after tool result, recovery). */
  continuation: boolean;
}

/**
 * Context passed to the `beforeTurn` hook.
 * Contains everything Think assembled — the hook can inspect and override.
 */
export interface TurnContext {
  /** Assembled system prompt (from context blocks or getSystemPrompt fallback). */
  system: string;
  /** Assembled model messages (truncated, pruned). */
  messages: ModelMessage[];
  /** Merged tool set (workspace + getTools + session + MCP + client + caller). */
  tools: ToolSet;
  /** The language model from getModel(). */
  model: LanguageModel;
  /** Whether this is a continuation turn. */
  continuation: boolean;
  /** Custom body fields from the client request. */
  body?: Record<string, unknown>;
}

/**
 * Configuration returned by the `beforeTurn` hook to override defaults.
 * All fields are optional — return only what you want to change.
 */
export interface TurnConfig {
  /** Override the model for this turn (e.g. cheap model for continuations). */
  model?: LanguageModel;
  /** Override the assembled system prompt. */
  system?: string;
  /** Override the assembled messages. */
  messages?: ModelMessage[];
  /** Extra tools to merge (additive — spread on top of existing tools). */
  tools?: ToolSet;
  /** Limit which tools the model can call (AI SDK activeTools). */
  activeTools?: string[];
  /** Force a specific tool call (AI SDK toolChoice). */
  toolChoice?: Parameters<typeof streamText>[0]["toolChoice"];
  /** Override maxSteps for this turn. */
  maxSteps?: number;
  /** Provider-specific options (AI SDK providerOptions). */
  providerOptions?: Record<string, unknown>;
}

/**
 * Context passed to the `beforeToolCall` hook **before** the tool's
 * `execute` function runs.
 *
 * Backed by the AI SDK's `OnToolCallStartEvent` (the parameter of
 * `experimental_onToolCallStart`). The full `TypedToolCall<TOOLS>`
 * fields (`toolName`, `toolCallId`, `input`, `providerMetadata`, the
 * dynamic/invalid/error discriminators) are spread at the top level for
 * convenience, with the per-call event extras attached:
 *
 * - `stepNumber` — index of the current step
 * - `messages`   — conversation messages visible at tool execution time
 * - `abortSignal` — signal that aborts if the turn is cancelled
 *
 * Pass an explicit `TOOLS` generic for full input typing:
 *
 * ```ts
 * import type { ToolCallContext } from "@cloudflare/think";
 * import type { tools } from "./my-tools";
 *
 * beforeToolCall(ctx: ToolCallContext<typeof tools>) {
 *   if (ctx.toolName === "search") {
 *     ctx.input.query; // typed
 *   }
 * }
 * ```
 */
export type ToolCallContext<TOOLS extends ToolSet = ToolSet> =
  TypedToolCall<TOOLS> & {
    /** Zero-based index of the current step where this tool call occurs. */
    readonly stepNumber: number | undefined;
    /** The conversation messages available at tool execution time. */
    readonly messages: ReadonlyArray<ModelMessage>;
    /** Signal for cancelling the operation. */
    readonly abortSignal: AbortSignal | undefined;
  };

/**
 * Decision returned by `beforeToolCall` to control tool execution.
 * Return void/undefined to allow execution with original input.
 *
 * Discriminated union — each action has a clear, non-overlapping meaning:
 * - `allow` — execute the tool (optionally with modified input)
 * - `block` — don't execute; return `reason` as the tool result so the model can adjust
 * - `substitute` — don't execute; return `output` as the tool result (afterToolCall still fires)
 */
export type ToolCallDecision =
  | {
      action: "allow";
      /** Modified input — tool executes with this instead of the original. */
      input?: Record<string, unknown>;
    }
  | {
      action: "block";
      /** Returned as the tool result so the model can adjust. */
      reason?: string;
    }
  | {
      action: "substitute";
      /** The substitute tool output — model sees this instead of real execution. */
      output: unknown;
      /** Optional input attribution for the afterToolCall log. */
      input?: Record<string, unknown>;
    };

/**
 * Context passed to the `afterToolCall` hook after a tool executes.
 *
 * Backed by the AI SDK's `OnToolCallFinishEvent` (the parameter of
 * `experimental_onToolCallFinish`). The full `TypedToolCall<TOOLS>`
 * fields (`toolName`, `toolCallId`, `input`, …) are spread at the top
 * level, plus the per-call event extras:
 *
 * - `stepNumber`  — index of the current step
 * - `messages`    — conversation messages visible at tool execution time
 * - `durationMs`  — wall-clock execution time in milliseconds
 * - `success`/`output`/`error` — discriminated outcome:
 *   - on success: `success: true`, `output: unknown`
 *   - on failure: `success: false`, `error: unknown`
 *
 * Pass an explicit `TOOLS` generic for full input typing:
 *
 * ```ts
 * import type { ToolCallResultContext } from "@cloudflare/think";
 * import type { tools } from "./my-tools";
 *
 * afterToolCall(ctx: ToolCallResultContext<typeof tools>) {
 *   if (ctx.success) {
 *     console.log(`${ctx.toolName} took ${ctx.durationMs}ms`, ctx.output);
 *   } else {
 *     console.error(`${ctx.toolName} failed:`, ctx.error);
 *   }
 * }
 * ```
 */
export type ToolCallResultContext<TOOLS extends ToolSet = ToolSet> =
  TypedToolCall<TOOLS> & {
    readonly stepNumber: number | undefined;
    readonly messages: ReadonlyArray<ModelMessage>;
    /** Wall-clock execution time in milliseconds. */
    readonly durationMs: number;
  } & (
      | {
          readonly success: true;
          readonly output: unknown;
          readonly error?: never;
        }
      | {
          readonly success: false;
          readonly output?: never;
          readonly error: unknown;
        }
    );

/**
 * Context passed to the `onStepFinish` hook after each step completes.
 *
 * This is the AI SDK's `StepResult<TOOLS>` (= `OnStepFinishEvent<TOOLS>`) —
 * the full step record including `text`, `reasoning`, `toolCalls`,
 * `toolResults`, `files`, `sources`, `usage` (with `cachedInputTokens`,
 * `reasoningTokens`, `totalTokens`), `finishReason`, `warnings`, `request`,
 * `response`, and `providerMetadata` (where provider-specific cache
 * accounting like `cacheCreationInputTokens` lives).
 *
 * Pass an explicit `TOOLS` generic for typed `toolCalls`/`toolResults`.
 */
export type StepContext<TOOLS extends ToolSet = ToolSet> = Parameters<
  StreamTextOnStepFinishCallback<TOOLS>
>[0];

/**
 * Context passed to the `onChunk` hook for each streaming chunk.
 *
 * This is the AI SDK's `StreamTextOnChunkCallback` event — `{ chunk }`
 * where `chunk` is a discriminated union of `TextStreamPart` variants
 * (text-delta, reasoning-delta, source, tool-call, tool-input-start,
 * tool-input-delta, tool-result, raw).
 */
export type ChunkContext<TOOLS extends ToolSet = ToolSet> = Parameters<
  StreamTextOnChunkCallback<TOOLS>
>[0];

/**
 * @internal Re-export of the chunk variant union for consumers that need
 * to narrow on `chunk.type` without importing `TextStreamPart` directly.
 */
export type ChunkPart<TOOLS extends ToolSet = ToolSet> =
  ChunkContext<TOOLS>["chunk"];

/**
 * Configuration for a sandboxed extension, returned by getExtensions().
 */
export interface ExtensionConfig {
  /** Extension manifest (name, version, permissions, contributions). */
  manifest: import("./extensions/types").ExtensionManifest;
  /** JavaScript source code defining the extension's tools. */
  source: string;
}

const TIMED_OUT = Symbol("timed-out");

/**
 * Controls how overlapping user submit requests behave while another
 * chat turn is already active or queued.
 *
 * - `"queue"` (default) — queue every submit and process them in order.
 * - `"latest"` — keep only the latest overlapping submit; superseded submits
 *   still persist their user messages, but do not start their own model turn.
 * - `"merge"` — like latest, but all overlapping user messages remain in
 *   the conversation history. The model sees them all in one turn.
 * - `"drop"` — ignore overlapping submits entirely (messages not persisted).
 * - `{ strategy: "debounce" }` — trailing-edge latest with a quiet window.
 *
 * Only applies to `submit-message` requests. Regenerations, tool
 * continuations, approvals, clears, `saveMessages`, and `continueLastTurn`
 * keep their existing serialized behavior.
 */
export type MessageConcurrency =
  | "queue"
  | "latest"
  | "merge"
  | "drop"
  | { strategy: "debounce"; debounceMs?: number };

type NormalizedMessageConcurrency =
  | "queue"
  | "latest"
  | "merge"
  | "drop"
  | { strategy: "debounce"; debounceMs: number };

type SubmitConcurrencyDecision = {
  action: "execute" | "drop";
  submitSequence: number | null;
  debounceUntilMs: number | null;
};

/**
 * Result passed to `onChatResponse` after a chat turn completes.
 */
export type ChatResponseResult = {
  message: UIMessage;
  requestId: string;
  continuation: boolean;
  status: "completed" | "error" | "aborted";
  error?: string;
};

/**
 * An opinionated chat agent base class.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Think<
  Env extends Cloudflare.Env = Cloudflare.Env,
  Config = Record<string, unknown>
> extends Agent<Env> {
  /**
   * Wait for MCP server connections to be ready before the inference
   * loop. MCP tools are auto-merged into the tool set.
   *
   * Set to `true` for a default 10s timeout, or `{ timeout: ms }`
   * for a custom timeout. Defaults to `false` (no waiting).
   */
  waitForMcpConnections: boolean | { timeout: number } = false;

  /**
   * Controls how overlapping user submit requests behave while another
   * chat turn is already active or queued.
   *
   * @default "queue"
   */
  messageConcurrency: MessageConcurrency = "queue";

  /**
   * When true, chat turns are wrapped in `runFiber` for durable execution.
   * Enables `onChatRecovery` hook and `this.stash()` during streaming.
   */
  chatRecovery = true;

  static readonly CHAT_FIBER_NAME = "__cf_internal_chat_turn";

  /** The conversation session — messages, context, compaction, search. */
  session!: Session;

  /**
   * WorkerLoader binding for sandboxed extensions.
   * Set this to enable `getExtensions()` and dynamic extension loading.
   */
  extensionLoader?: WorkerLoader;

  /**
   * Extension manager — created automatically when `extensionLoader` is set.
   * Use for dynamic `load()` / `unload()` at runtime.
   */
  extensionManager?: import("./extensions/manager").ExtensionManager;

  /**
   * Workspace filesystem backed by the DO's SQLite storage.
   * Available in `getTools()` and lifecycle hooks.
   *
   * Override to add R2 spillover for large files:
   * ```typescript
   * override workspace = new Workspace({
   *   sql: this.ctx.storage.sql,
   *   r2: this.env.R2,
   *   name: () => this.name
   * });
   * ```
   */
  workspace!: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const _onStart = this.onStart.bind(this);
    this.onStart = async () => {
      // 1. Workspace initialization
      if (!this.workspace) {
        this.workspace = new Workspace({
          sql: this.ctx.storage.sql,
          name: () => this.name
        });
      }

      // 2. Session configuration (builder phase — context blocks, compaction, skills)
      const baseSession = Session.create(this);
      this.session = await this.configureSession(baseSession);

      // Force Session to initialize its tables (assistant_messages,
      // assistant_config, etc.) so that subsequent config reads work.
      this.session.getHistory();

      // 3-6. Extension initialization (if extensionLoader is set)
      if (this.extensionLoader) {
        await this._initializeExtensions();
      }

      // 7. Protocol handlers
      this._resumableStream = new ResumableStream(this.sql.bind(this));
      this._restoreClientTools();
      this._restoreBody();
      this._setupProtocolHandlers();

      // 8. User's onStart
      await _onStart();
    };
  }

  /**
   * Conversation history. Computed from the active session.
   * Always fresh — reads from Session's tree-structured storage.
   */
  get messages(): UIMessage[] {
    return this.session.getHistory() as UIMessage[];
  }

  private _aborts = new AbortRegistry();
  private _turnQueue = new TurnQueue();
  private _resumableStream!: ResumableStream;
  private _pendingResumeConnections: Set<string> = new Set();
  private _lastClientTools: ClientToolSchema[] | undefined;
  private _lastBody: Record<string, unknown> | undefined;
  private _continuation = new ContinuationState();
  private _continuationTimer: ReturnType<typeof setTimeout> | null = null;
  private _insideResponseHook = false;
  private _insideInferenceLoop = false;
  private _pendingInteractionPromise: Promise<boolean> | null = null;
  private _submitSequence = 0;
  private _latestOverlappingSubmitSequence = 0;
  private _activeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _activeDebounceResolve: (() => void) | null = null;
  private static MESSAGE_DEBOUNCE_MS = 750;

  // ── Dynamic config ──────────────────────────────────────────────

  #configCache: Config | null = null;

  /**
   * Persist a typed configuration object.
   * Stored in Session's assistant_config table — survives restarts and hibernation.
   */
  configure(config: Config): void {
    const json = JSON.stringify(config);
    this._configSet("_think_config", json);
    this.#configCache = config;
  }

  /**
   * Read the persisted configuration, or null if never configured.
   */
  getConfig(): Config | null {
    if (this.#configCache) return this.#configCache;
    const raw = this._configGet("_think_config");
    if (raw !== undefined) {
      this.#configCache = JSON.parse(raw) as Config;
      return this.#configCache;
    }
    return null;
  }

  // ── Config storage helpers (assistant_config table) ─────────────

  #configTableReady = false;

  private _ensureConfigTable(): void {
    if (this.#configTableReady) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS assistant_config (
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (session_id, key)
      )
    `;
    this.#configTableReady = true;
  }

  private _configSet(key: string, value: string): void {
    this._ensureConfigTable();
    const sessionId = this._sessionId();
    this.sql`
      INSERT OR REPLACE INTO assistant_config (session_id, key, value)
      VALUES (${sessionId}, ${key}, ${value})
    `;
  }

  private _configGet(key: string): string | undefined {
    this._ensureConfigTable();
    const sessionId = this._sessionId();
    const rows = this.sql<{ value: string }>`
      SELECT value FROM assistant_config
      WHERE session_id = ${sessionId} AND key = ${key}
    `;
    return rows[0]?.value;
  }

  private _configDelete(key: string): void {
    this._ensureConfigTable();
    const sessionId = this._sessionId();
    this.sql`
      DELETE FROM assistant_config
      WHERE session_id = ${sessionId} AND key = ${key}
    `;
  }

  private _sessionId(): string {
    return "";
  }

  // ── Configuration overrides ─────────────────────────────────────

  /**
   * Return the language model to use for inference.
   * Must be overridden by subclasses.
   */
  getModel(): LanguageModel {
    throw new Error("Override getModel() to return a LanguageModel.");
  }

  /**
   * Return the system prompt for the assistant.
   * Used as fallback when no context blocks are configured via `configureSession`.
   */
  getSystemPrompt(): string {
    return "You are a helpful assistant.";
  }

  /** Return the tools available to the assistant. */
  getTools(): ToolSet {
    return {};
  }

  /** Maximum number of tool-call steps per turn. Override via property or per-turn via TurnConfig. */
  maxSteps = 10;

  /**
   * Configure the session. Called once during `onStart`.
   * Override to add context blocks, compaction, search, skills.
   *
   * @example
   * ```typescript
   * configureSession(session: Session) {
   *   return session
   *     .withContext("memory", { description: "Learned facts", maxTokens: 2000 })
   *     .withCachedPrompt();
   * }
   * ```
   */
  configureSession(session: Session): Session | Promise<Session> {
    return session;
  }

  /**
   * Return sandboxed extension configurations. Defines load order,
   * which determines hook execution order.
   * Requires `extensionLoader` to be set.
   */
  getExtensions(): ExtensionConfig[] {
    return [];
  }

  // ── Lifecycle hooks ───────────────────────────────────────────

  /**
   * Called before `streamText` — inspect the assembled context and
   * return overrides. Think assembles tools, system prompt, and messages
   * internally; this hook sees the result and can override any part.
   *
   * Return `void` to accept all defaults.
   *
   * @example Switch model for continuations
   * ```typescript
   * beforeTurn(ctx: TurnContext) {
   *   if (ctx.continuation) return { model: this.cheapModel };
   * }
   * ```
   *
   * @example Restrict active tools
   * ```typescript
   * beforeTurn(ctx: TurnContext) {
   *   return { activeTools: ["read", "write"] };
   * }
   * ```
   */
  beforeTurn(
    _ctx: TurnContext
  ): TurnConfig | void | Promise<TurnConfig | void> {}

  /**
   * Called **before** the tool's `execute` function runs. Think wraps
   * every tool's `execute` so it can consult this hook and act on the
   * returned `ToolCallDecision`:
   *
   * - `void` (or `{ action: "allow" }` with no `input`) — run the
   *   original `execute` with the original input.
   * - `{ action: "allow", input }` — run the original `execute` with
   *   the substituted input.
   * - `{ action: "block", reason }` — skip `execute`; the model sees
   *   `reason` as the tool's output.
   * - `{ action: "substitute", output }` — skip `execute`; the model
   *   sees `output` as the tool's output.
   *
   * Only fires for server-side tools (tools with `execute`). Client
   * tools are handled on the client — Think can't intercept them.
   *
   * `afterToolCall` always fires after this hook (or after the original
   * `execute` when `allow`). For `block`/`substitute`, the substituted
   * value flows through `afterToolCall` as `success: true, output: ...`.
   *
   * @example Log tool calls
   * ```typescript
   * beforeToolCall(ctx: ToolCallContext) {
   *   console.log(`Tool called: ${ctx.toolName}`, ctx.input);
   * }
   * ```
   *
   * @example Block a tool the model shouldn't be calling here
   * ```typescript
   * beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
   *   if (ctx.toolName === "delete" && this.isReadOnlyMode) {
   *     return { action: "block", reason: "delete is disabled in read-only mode" };
   *   }
   * }
   * ```
   *
   * @example Substitute a cached result
   * ```typescript
   * async beforeToolCall(ctx: ToolCallContext): Promise<ToolCallDecision | void> {
   *   if (ctx.toolName === "weather") {
   *     const cached = await this.cache.get(JSON.stringify(ctx.input));
   *     if (cached) return { action: "substitute", output: cached };
   *   }
   * }
   * ```
   */
  beforeToolCall(
    _ctx: ToolCallContext
  ): ToolCallDecision | void | Promise<ToolCallDecision | void> {}

  /**
   * Called **after** a tool's outcome is known — for real executions, for
   * `block` (carries the `reason` as `output`), and for `substitute`
   * (carries the substituted `output`). Backed by the AI SDK's
   * `experimental_onToolCallFinish`, so `durationMs` and the discriminated
   * `success`/`output`/`error` outcome reflect what the model actually
   * sees: a thrown error from the original `execute` becomes
   * `success: false, error: ...`; everything else (including blocked /
   * substituted calls) is `success: true, output: ...`.
   *
   * Override for logging, metrics, or result inspection.
   *
   * @example
   * ```typescript
   * afterToolCall(ctx: ToolCallResultContext) {
   *   if (ctx.success) {
   *     console.log(`${ctx.toolName} ok in ${ctx.durationMs}ms`);
   *   } else {
   *     console.error(`${ctx.toolName} failed:`, ctx.error);
   *   }
   * }
   * ```
   */
  afterToolCall(_ctx: ToolCallResultContext): void | Promise<void> {}

  /**
   * Called after each step completes (initial, continue, tool-result).
   * Override for step-level logging or analytics.
   */
  onStepFinish(_ctx: StepContext): void | Promise<void> {}

  /**
   * Called for each streaming chunk. High-frequency — fires per token.
   * Override for streaming analytics, progress indicators, or token counting.
   * Observational only (void return).
   */
  onChunk(_ctx: ChunkContext): void | Promise<void> {}

  /**
   * Called after a chat turn completes and the assistant message has been
   * persisted. The turn lock is released before this hook runs, so it is
   * safe to call other methods from inside.
   *
   * Fires for all turn completion paths: WebSocket chat requests,
   * sub-agent RPC, and auto-continuation.
   *
   * Override for logging, chaining, analytics, usage tracking.
   */
  onChatResponse(_result: ChatResponseResult): void | Promise<void> {}

  /**
   * Handle an error that occurred during a chat turn.
   * Override to customize error handling (e.g. logging, metrics).
   */
  onChatError(error: unknown): unknown {
    return error;
  }

  // ── Extension initialization ───────────────────────────────────

  private async _initializeExtensions(): Promise<void> {
    const { ExtensionManager } = await import("./extensions/manager");
    const { sanitizeName } = await import("./extensions/manager");

    // 3. Create ExtensionManager with host binding if HostBridgeLoopback
    // is re-exported from the worker entry point.
    const agentClassName = this.constructor.name;
    const agentId = this.ctx.id.toString();
    const ctxExports = (this.ctx as unknown as Record<string, unknown>)
      .exports as Record<string, unknown> | undefined;
    const hasBridge =
      ctxExports && typeof ctxExports.HostBridgeLoopback === "function";

    this.extensionManager = new ExtensionManager({
      loader: this.extensionLoader!,
      storage: this.ctx.storage,
      ...(hasBridge
        ? {
            createHostBinding: (
              permissions: import("./extensions/types").ExtensionPermissions,
              ownContextLabels: string[]
            ) =>
              (
                ctxExports.HostBridgeLoopback as (opts: {
                  props: Record<string, unknown>;
                }) => Fetcher
              )({
                props: {
                  agentClassName,
                  agentId,
                  permissions,
                  ownContextLabels
                }
              })
          }
        : {})
    });

    // 4. Load static extensions from getExtensions()
    const configs = this.getExtensions();
    for (const config of configs) {
      await this.extensionManager.load(config.manifest, config.source);
    }

    // 5. Restore dynamic extensions from DO storage
    await this.extensionManager.restore();

    // 6. Register extension context blocks in Session (mutation phase).
    // Context blocks use SQLite-backed AgentContextProvider (no bridge
    // delegation to the extension Worker). Extensions write to their
    // blocks via host.setContext() (Phase 3). Bridge providers that
    // delegate to extension Worker RPC methods are Phase 4.
    for (const ext of this.extensionManager.list()) {
      const manifest = this.extensionManager.getManifest(ext.name);
      if (!manifest?.context) continue;

      const prefix = sanitizeName(ext.name);
      for (const ctxDef of manifest.context) {
        const namespacedLabel = `${prefix}_${ctxDef.label}`;
        await this.session.addContext(namespacedLabel, {
          description: ctxDef.description,
          maxTokens: ctxDef.maxTokens
        });
      }
    }

    // Wire unload callback to clean up context blocks
    this.extensionManager.onUnload(async (_name, contextLabels) => {
      for (const label of contextLabels) {
        this.session.removeContext(label);
      }
      await this.session.refreshSystemPrompt();
    });
  }

  // ── Inference loop (Think owns this) ──────────────────────────

  /**
   * The single convergence point for all chat turn entry paths.
   * Merges tools, assembles context, fires lifecycle hooks, wraps tools
   * for interception, and calls streamText.
   */
  private async _runInferenceLoop(input: TurnInput): Promise<StreamableResult> {
    if (this.waitForMcpConnections) {
      const timeout =
        typeof this.waitForMcpConnections === "object"
          ? this.waitForMcpConnections.timeout
          : 10_000;
      await this.mcp.waitForConnections({ timeout });
    }

    const workspaceTools = createWorkspaceTools(this.workspace);
    const baseTools = this.getTools();
    const extensionTools = this.extensionManager?.getTools() ?? {};
    const contextTools = await this.session.tools();
    const clientToolSet = createToolsFromClientSchemas(input.clientTools);
    const tools: ToolSet = {
      ...workspaceTools,
      ...baseTools,
      ...extensionTools,
      ...contextTools,
      ...(this.mcp?.getAITools?.() ?? {}),
      ...clientToolSet,
      ...input.callerTools
    };

    const frozenPrompt = await this.session.freezeSystemPrompt();
    const system = frozenPrompt || this.getSystemPrompt();

    const history = this.session.getHistory();
    const truncated = truncateOlderMessages(history) as UIMessage[];
    const messages = pruneMessages({
      messages: await convertToModelMessages(truncated),
      toolCalls: "before-last-2-messages"
    });

    if (messages.length === 0) {
      throw new Error(
        "No messages to send to the model. This usually means the chat request " +
          "arrived before any messages were persisted."
      );
    }

    const model = this.getModel();
    const ctx: TurnContext = {
      system,
      messages,
      tools,
      model,
      continuation: input.continuation,
      body: input.body
    };

    const subclassConfig = (await this.beforeTurn(ctx)) ?? {};
    const config = await this._pipelineExtensionBeforeTurn(ctx, subclassConfig);

    const finalModel = config.model ?? model;
    const finalSystem = config.system ?? system;
    const finalMessages = config.messages ?? messages;
    const mergedTools: ToolSet = config.tools
      ? { ...tools, ...config.tools }
      : tools;
    // Wrap each tool's `execute` so `beforeToolCall` is consulted before
    // the tool actually runs. The wrapped `execute` honors the returned
    // `ToolCallDecision` — `block` short-circuits with `reason`,
    // `substitute` returns `output` directly, `allow` runs the original
    // (optionally with modified `input`).
    const finalTools: ToolSet = this._wrapToolsWithDecision(mergedTools);
    const finalMaxSteps = config.maxSteps ?? this.maxSteps;

    const result = streamText({
      model: finalModel,
      system: finalSystem,
      messages: finalMessages,
      tools: finalTools,
      activeTools: config.activeTools,
      toolChoice: config.toolChoice,
      stopWhen: stepCountIs(finalMaxSteps),
      providerOptions: config.providerOptions as
        | Parameters<typeof streamText>[0]["providerOptions"]
        | undefined,
      abortSignal: input.signal,
      onChunk: async (event) => {
        // Pass the AI SDK's chunk event through unchanged — gives users
        // access to the discriminated `TextStreamPart` chunk with all
        // provider metadata.
        await this.onChunk(event);
        await this._pipelineExtensionChunk(event);
      },
      onStepFinish: async (event) => {
        // Pass the full StepResult through — gives users access to
        // reasoning, sources, files, providerMetadata (cache tokens),
        // request/response, warnings, and the full LanguageModelUsage
        // that the AI SDK provides.
        await this.onStepFinish(event);
        await this._pipelineExtensionStepFinish(event);
      },
      // `beforeToolCall` is dispatched from the wrapped `execute` (see
      // `_wrapToolsWithDecision` above) so the returned `ToolCallDecision`
      // can actually intercept the call. `afterToolCall` is wired through
      // the AI SDK's `experimental_onToolCallFinish` callback so we get
      // accurate `durationMs` and the discriminated `success`/`error`
      // outcome — including failures that propagate out of `execute`.
      experimental_onToolCallFinish: (async (event) => {
        const base = {
          ...event.toolCall,
          stepNumber: event.stepNumber,
          messages: event.messages,
          durationMs: event.durationMs
        };
        const ctx = (
          event.success
            ? { ...base, success: true as const, output: event.output }
            : { ...base, success: false as const, error: event.error }
        ) as ToolCallResultContext;
        await this.afterToolCall(ctx);
        await this._pipelineExtensionToolCallFinish(event);
      }) satisfies StreamTextOnToolCallFinishCallback<ToolSet>
    });

    return this._transformInferenceResult(result);
  }

  /** @internal Test seam — override in test agents to wrap the stream (e.g. error injection). */
  protected _transformInferenceResult(
    result: StreamableResult
  ): StreamableResult {
    return result;
  }

  /** Default hook timeout in milliseconds. */
  hookTimeout = 5000;

  /**
   * Pipeline beforeTurn through sandboxed extensions in load order.
   * Each extension sees the accumulated state from prior extensions
   * (snapshot is rebuilt after each extension's modifications).
   * Results are merged with last-write-wins for scalar fields.
   * Extensions that don't subscribe to beforeTurn are skipped.
   */
  private async _pipelineExtensionBeforeTurn(
    ctx: TurnContext,
    subclassConfig: TurnConfig
  ): Promise<TurnConfig> {
    if (!this.extensionManager) return subclassConfig;

    const subscribers = this.extensionManager.getHookSubscribers("beforeTurn");
    if (subscribers.length === 0) return subclassConfig;

    const { createTurnContextSnapshot, parseHookResult } =
      await import("./extensions/hook-proxy");

    let snapshot = createTurnContextSnapshot(ctx);
    let accumulated = { ...subclassConfig };

    // Apply subclass config to the initial snapshot so extensions
    // see the subclass overrides
    if (accumulated.system !== undefined) snapshot.system = accumulated.system;
    if (accumulated.maxSteps !== undefined)
      snapshot.messageCount = ctx.messages.length;

    for (const sub of subscribers) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const resultJson = await Promise.race([
          sub.entrypoint.hook("beforeTurn", snapshot),
          new Promise<string>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Hook timeout: ${sub.name}`)),
              this.hookTimeout
            );
          })
        ]);

        const parsed = parseHookResult(resultJson);
        if ("config" in parsed) {
          // Merge serializable scalars only. model and tools are skipped —
          // sandboxed extensions can't return LanguageModel or AI SDK Tool
          // objects (not serializable across RPC). Use activeTools to
          // control which tools the model can call.
          if (parsed.config.system !== undefined)
            accumulated.system = parsed.config.system;
          if (parsed.config.messages !== undefined)
            accumulated.messages = parsed.config.messages;
          if (parsed.config.activeTools !== undefined)
            accumulated.activeTools = parsed.config.activeTools;
          if (parsed.config.toolChoice !== undefined)
            accumulated.toolChoice = parsed.config.toolChoice;
          if (parsed.config.maxSteps !== undefined)
            accumulated.maxSteps = parsed.config.maxSteps;
          if (parsed.config.providerOptions !== undefined) {
            accumulated.providerOptions = {
              ...(accumulated.providerOptions ?? {}),
              ...parsed.config.providerOptions
            };
          }
          // Update snapshot so next extension sees this extension's changes
          if (accumulated.system !== undefined)
            snapshot = { ...snapshot, system: accumulated.system };
          if (accumulated.activeTools !== undefined)
            snapshot = { ...snapshot, toolNames: accumulated.activeTools };
        } else if ("error" in parsed) {
          console.warn(
            `[Think] Extension "${sub.name}" beforeTurn error:`,
            parsed.error
          );
        }
      } catch (err) {
        console.warn(
          `[Think] Extension "${sub.name}" beforeTurn failed:`,
          err instanceof Error ? err.message : err
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    return accumulated;
  }

  /**
   * Dispatch an observation hook to all extensions that subscribe to it.
   *
   * Used by `_pipelineExtensionToolCallStart`, `_pipelineExtensionToolCallFinish`,
   * `_pipelineExtensionStepFinish`, and `_pipelineExtensionChunk`. Unlike
   * `beforeTurn`, these hooks are observation-only — extensions can't
   * influence the turn — so we ignore return values, log errors, and
   * apply a per-extension timeout.
   *
   * `onChunk` is high-frequency (per token) — extensions that subscribe
   * to it pay an RPC cost per chunk and should be used sparingly.
   */
  private async _dispatchExtensionObservation(
    hookName: "beforeToolCall" | "afterToolCall" | "onStepFinish" | "onChunk",
    snapshot: unknown
  ): Promise<void> {
    if (!this.extensionManager) return;
    const subscribers = this.extensionManager.getHookSubscribers(hookName);
    if (subscribers.length === 0) return;

    for (const sub of subscribers) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sub.entrypoint.hook(hookName, snapshot),
          new Promise<string>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Hook timeout: ${sub.name}`)),
              this.hookTimeout
            );
          })
        ]);
      } catch (err) {
        console.warn(
          `[Think] Extension "${sub.name}" ${hookName} failed:`,
          err instanceof Error ? err.message : err
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }

  /**
   * Wrap each tool's `execute` function so the agent's `beforeToolCall`
   * hook is consulted before the tool runs. The hook can return a
   * `ToolCallDecision` to:
   *
   * - `allow` (default if `void` is returned) — run the original
   *   `execute`, optionally with a substituted `input`.
   * - `block` — skip `execute` and return `reason` (or a default string)
   *   as the tool result. The model sees this as the tool's output.
   * - `substitute` — skip `execute` and return `output` directly. The
   *   model sees this as the tool's output.
   *
   * The wrapped `execute` also dispatches the `beforeToolCall`
   * observation snapshot to subscribed extensions. `afterToolCall` is
   * still wired through the AI SDK's `experimental_onToolCallFinish`
   * callback so we get accurate `durationMs` and proper success/error
   * discrimination — `block` and `substitute` outcomes show up as
   * `success: true` with the substituted output; uncaught throws from
   * the original `execute` show up as `success: false` with the error.
   *
   * Tools without an `execute` (output-schema-only tools, client tools
   * routed via `needsApproval`) are left untouched.
   *
   * **Streaming tools (AsyncIterable):** the AI SDK supports tools that
   * return `AsyncIterable<output>` to emit preliminary results before a
   * final value. Because the wrapper must `await beforeToolCall` first,
   * preliminary chunks are collapsed — only the *final* yielded value
   * reaches the model. If you need true streaming, override `getTools()`
   * to provide such tools and avoid using `beforeToolCall` for them
   * (or accept the collapse).
   */
  private _wrapToolsWithDecision(tools: ToolSet): ToolSet {
    const wrapped: ToolSet = {};
    for (const [toolName, originalTool] of Object.entries(tools)) {
      const t = originalTool as Record<string, unknown>;
      const originalExecute = t.execute as
        | ((input: unknown, options: unknown) => unknown | Promise<unknown>)
        | undefined;
      if (typeof originalExecute !== "function") {
        wrapped[toolName] = originalTool;
        continue;
      }

      const isDynamic = t.type === "dynamic";

      const wrappedExecute = async (
        input: unknown,
        options: {
          toolCallId: string;
          messages: ModelMessage[];
          abortSignal?: AbortSignal;
          experimental_context?: unknown;
        }
      ): Promise<unknown> => {
        // Build the discriminated `TypedToolCall`-shaped context.
        const toolCallBase = {
          type: "tool-call" as const,
          toolCallId: options.toolCallId,
          toolName,
          input,
          ...(isDynamic ? { dynamic: true as const } : {})
        };

        const ctx = {
          ...toolCallBase,
          stepNumber: undefined,
          messages: options.messages,
          abortSignal: options.abortSignal
        } as ToolCallContext;

        // Subclass decision first.
        const decision = await this.beforeToolCall(ctx);

        // Extension observation dispatch — runs after the subclass so
        // extensions see whatever effect the subclass had on the
        // decision shape (input substitution shows up in the snapshot).
        const dispatchInput =
          decision && decision.action === "allow" && decision.input
            ? decision.input
            : input;
        await this._pipelineExtensionToolCallStart({
          toolCall: {
            ...toolCallBase,
            input: dispatchInput
          } as TypedToolCall<ToolSet>,
          stepNumber: undefined
        });

        // Resolve the decision.
        if (!decision || decision.action === "allow") {
          const finalInput = decision?.input ?? input;
          const result = originalExecute(finalInput, options);
          // If the original tool yields preliminary results (AsyncIterable)
          // collapse to the last value. Returning `Promise<AsyncIterable>`
          // unchanged would make the AI SDK treat the iterator instance
          // itself as the final output (broken). We trade preliminary
          // streaming for `beforeToolCall` interception support.
          if (
            result != null &&
            typeof result === "object" &&
            Symbol.asyncIterator in (result as object)
          ) {
            let last: unknown;
            for await (const part of result as AsyncIterable<unknown>) {
              last = part;
            }
            return last;
          }
          return result;
        }
        if (decision.action === "block") {
          return (
            decision.reason ??
            `Tool "${toolName}" was blocked by beforeToolCall.`
          );
        }
        // substitute
        return decision.output;
      };

      wrapped[toolName] = {
        ...(originalTool as object),
        execute: wrappedExecute
      } as ToolSet[string];
    }
    return wrapped;
  }

  private async _pipelineExtensionToolCallStart(event: {
    toolCall: TypedToolCall<ToolSet>;
    stepNumber: number | undefined;
  }): Promise<void> {
    if (!this.extensionManager) return;
    if (this.extensionManager.getHookSubscribers("beforeToolCall").length === 0)
      return;
    const { createToolCallStartSnapshot } =
      await import("./extensions/hook-proxy");
    await this._dispatchExtensionObservation(
      "beforeToolCall",
      createToolCallStartSnapshot(event)
    );
  }

  private async _pipelineExtensionToolCallFinish(event: {
    toolCall: TypedToolCall<ToolSet>;
    stepNumber: number | undefined;
    durationMs: number;
    success: boolean;
    output?: unknown;
    error?: unknown;
  }): Promise<void> {
    if (!this.extensionManager) return;
    if (this.extensionManager.getHookSubscribers("afterToolCall").length === 0)
      return;
    const { createToolCallFinishSnapshot } =
      await import("./extensions/hook-proxy");
    await this._dispatchExtensionObservation(
      "afterToolCall",
      createToolCallFinishSnapshot(event)
    );
  }

  private async _pipelineExtensionStepFinish(
    event: StepContext
  ): Promise<void> {
    if (!this.extensionManager) return;
    if (this.extensionManager.getHookSubscribers("onStepFinish").length === 0)
      return;
    const { createStepFinishSnapshot } =
      await import("./extensions/hook-proxy");
    await this._dispatchExtensionObservation(
      "onStepFinish",
      createStepFinishSnapshot(event)
    );
  }

  private async _pipelineExtensionChunk(event: ChunkContext): Promise<void> {
    if (!this.extensionManager) return;
    if (this.extensionManager.getHookSubscribers("onChunk").length === 0)
      return;
    const { createChunkSnapshot } = await import("./extensions/hook-proxy");
    await this._dispatchExtensionObservation(
      "onChunk",
      createChunkSnapshot(event as { chunk: { type: string } })
    );
  }

  // ── Host bridge methods (called by HostBridgeLoopback via DO RPC) ──

  async _hostReadFile(path: string): Promise<string | null> {
    return (await this.workspace.readFile(path)) ?? null;
  }

  async _hostWriteFile(path: string, content: string): Promise<void> {
    await this.workspace.writeFile(path, content);
  }

  async _hostDeleteFile(path: string): Promise<boolean> {
    try {
      await this.workspace.rm(path);
      return true;
    } catch {
      return false;
    }
  }

  async _hostListFiles(
    dir: string
  ): Promise<
    Array<{ name: string; type: string; size: number; path: string }>
  > {
    const entries = await this.workspace.readDir(dir);
    return entries.map((e) => ({
      name: e.name,
      type: e.type,
      size: e.size ?? 0,
      path: e.path ?? `${dir}/${e.name}`
    }));
  }

  async _hostGetContext(label: string): Promise<string | null> {
    const block = this.session.getContextBlock(label);
    return block?.content ?? null;
  }

  async _hostSetContext(label: string, content: string): Promise<void> {
    await this.session.replaceContextBlock(label, content);
  }

  async _hostGetMessages(
    limit?: number
  ): Promise<Array<{ id: string; role: string; content: string }>> {
    const history = this.session.getHistory();
    const sliced =
      limit !== undefined && limit !== null
        ? limit <= 0
          ? []
          : history.slice(-limit)
        : history;
    return sliced.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("")
    }));
  }

  async _hostSendMessage(content: string): Promise<void> {
    const msg = {
      id: crypto.randomUUID(),
      role: "user" as const,
      parts: [{ type: "text" as const, text: content }]
    };
    // Append directly to session — do NOT route through saveMessages,
    // which enqueues a full turn via TurnQueue and would deadlock if
    // called during an active turn (tool execution → host.sendMessage
    // → saveMessages → TurnQueue.enqueue → awaits current turn → deadlock).
    // The injected message is visible in the next turn's history.
    await this.session.appendMessage(msg);
  }

  async _hostGetSessionInfo(): Promise<{
    messageCount: number;
  }> {
    return {
      messageCount: this.session.getHistory().length
    };
  }

  // ── Sub-agent RPC entry point ───────────────────────────────────

  /**
   * Run a chat turn: persist the user message, run the agentic loop,
   * stream UIMessageChunk events via callback, and persist the
   * assistant's response.
   *
   * @param userMessage The user's message (string or UIMessage)
   * @param callback Streaming callback (typically an RpcTarget from the parent)
   * @param options Optional chat options (e.g. AbortSignal)
   */
  async chat(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    options?: ChatOptions
  ): Promise<void> {
    const requestId = crypto.randomUUID();

    await this._turnQueue.enqueue(requestId, async () => {
      const userMsg: UIMessage =
        typeof userMessage === "string"
          ? {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: userMessage }]
            }
          : userMessage;

      await this.session.appendMessage(userMsg);

      const accumulator = new StreamAccumulator({
        messageId: crypto.randomUUID()
      });

      try {
        const result = await agentContext.run(
          {
            agent: this,
            connection: undefined,
            request: undefined,
            email: undefined
          },
          () =>
            this._runInferenceLoop({
              signal: options?.signal,
              callerTools: options?.tools,
              continuation: false
            })
        );

        this._insideInferenceLoop = true;
        let aborted = false;
        try {
          for await (const chunk of result.toUIMessageStream()) {
            if (options?.signal?.aborted) {
              aborted = true;
              break;
            }
            accumulator.applyChunk(chunk as unknown as StreamChunkData);
            await callback.onEvent(JSON.stringify(chunk));
          }
        } finally {
          this._insideInferenceLoop = false;
        }

        const assistantMsg = accumulator.toMessage();
        this._persistAssistantMessage(assistantMsg);

        if (!aborted) {
          await callback.onDone();
          await this._fireResponseHook({
            message: assistantMsg,
            requestId,
            continuation: false,
            status: "completed"
          });
        } else {
          await this._fireResponseHook({
            message: assistantMsg,
            requestId,
            continuation: false,
            status: "aborted"
          });
        }
      } catch (error) {
        const assistantMsg =
          accumulator.parts.length > 0 ? accumulator.toMessage() : null;
        if (assistantMsg) {
          this._persistAssistantMessage(assistantMsg);
        }

        const wrapped = this.onChatError(error);
        const errorMessage =
          wrapped instanceof Error ? wrapped.message : String(wrapped);

        if (assistantMsg) {
          await this._fireResponseHook({
            message: assistantMsg,
            requestId,
            continuation: false,
            status: "error",
            error: errorMessage
          });
        }

        if (callback.onError) {
          await callback.onError(errorMessage);
        } else {
          throw wrapped;
        }
      }
    });
  }

  // ── Message access ──────────────────────────────────────────────

  /** Get the conversation history as UIMessage[]. */
  getMessages(): UIMessage[] {
    return this.messages;
  }

  /** Clear all messages from storage. */
  clearMessages(): void {
    this.session.clearMessages();
  }

  // ── Programmatic API ───────────────────────────────────────────

  /**
   * Inject messages and trigger a model turn — without a WebSocket request.
   *
   * Use for scheduled responses, webhook-triggered turns, proactive agents,
   * or chaining from `onChatResponse`.
   *
   * Accepts static messages or a callback that derives messages from the
   * current state (useful when multiple calls queue up — the callback runs
   * with the latest messages when the turn actually starts).
   *
   * @example Scheduled follow-up
   * ```typescript
   * async onScheduled() {
   *   await this.saveMessages([{
   *     id: crypto.randomUUID(),
   *     role: "user",
   *     parts: [{ type: "text", text: "Time for your daily summary." }]
   *   }]);
   * }
   * ```
   *
   * @example Function form
   * ```typescript
   * await this.saveMessages((current) => [
   *   ...current,
   *   { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "Continue." }] }
   * ]);
   * ```
   */
  async saveMessages(
    messages:
      | UIMessage[]
      | ((currentMessages: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>)
  ): Promise<SaveMessagesResult> {
    const requestId = crypto.randomUUID();
    const clientTools = this._lastClientTools;
    const body = this._lastBody;
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";

    await this.keepAliveWhile(async () => {
      await this._turnQueue.enqueue(requestId, async () => {
        const resolved =
          typeof messages === "function"
            ? await messages(this.messages)
            : messages;

        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        for (const msg of resolved) {
          await this.session.appendMessage(msg);
        }
        this._broadcastMessages();

        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        const abortSignal = this._aborts.getSignal(requestId);
        try {
          const programmaticBody = async () => {
            const result = await agentContext.run(
              {
                agent: this,
                connection: undefined,
                request: undefined,
                email: undefined
              },
              () =>
                this._runInferenceLoop({
                  signal: abortSignal,
                  clientTools,
                  body,
                  continuation: false
                })
            );

            if (result) {
              await this._streamResult(requestId, result, abortSignal);
            }
          };

          if (this.chatRecovery) {
            await this.runFiber(
              `${(this.constructor as typeof Think).CHAT_FIBER_NAME}:${requestId}`,
              async () => {
                await programmaticBody();
              }
            );
          } else {
            await programmaticBody();
          }
        } finally {
          this._aborts.remove(requestId);
        }
      });
    });

    if (this._turnQueue.generation !== epoch && status === "completed") {
      status = "skipped";
    }

    return { requestId, status };
  }

  /**
   * Run a new LLM call following the last assistant message.
   *
   * The model sees the full conversation (including the last assistant
   * response) and generates a new response. The new response is persisted
   * as a separate assistant message. Building block for chat recovery
   * (Phase 4), "generate more" buttons, and self-correction.
   *
   * Note: this creates a new message, not an append to the existing one.
   * True continuation-as-append (chunk rewriting) is planned for Phase 4.
   *
   * Returns early with `status: "skipped"` if there is no assistant message
   * to continue from.
   */
  protected async continueLastTurn(
    body?: Record<string, unknown>
  ): Promise<SaveMessagesResult> {
    const lastLeaf = this.session.getLatestLeaf();
    if (!lastLeaf || lastLeaf.role !== "assistant") {
      return { requestId: "", status: "skipped" };
    }

    const requestId = crypto.randomUUID();
    const clientTools = this._lastClientTools;
    const resolvedBody = body ?? this._lastBody;
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";

    await this.keepAliveWhile(async () => {
      await this._turnQueue.enqueue(requestId, async () => {
        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        const abortSignal = this._aborts.getSignal(requestId);
        try {
          const continueTurnBody = async () => {
            const result = await agentContext.run(
              {
                agent: this,
                connection: undefined,
                request: undefined,
                email: undefined
              },
              () =>
                this._runInferenceLoop({
                  signal: abortSignal,
                  clientTools,
                  body: resolvedBody,
                  continuation: true
                })
            );

            if (result) {
              await this._streamResult(requestId, result, abortSignal, {
                continuation: true
              });
            }
          };

          if (this.chatRecovery) {
            await this.runFiber(
              `${(this.constructor as typeof Think).CHAT_FIBER_NAME}:${requestId}`,
              async () => {
                await continueTurnBody();
              }
            );
          } else {
            await continueTurnBody();
          }
        } finally {
          this._aborts.remove(requestId);
        }
      });
    });

    if (this._turnQueue.generation !== epoch && status === "completed") {
      status = "skipped";
    }

    return { requestId, status };
  }

  // ── WebSocket protocol ──────────────────────────────────────────

  private _setupProtocolHandlers() {
    const _onConnect = this.onConnect.bind(this);
    this.onConnect = async (
      connection: Connection,
      ctx: { request: Request }
    ) => {
      if (this._resumableStream.hasActiveStream()) {
        this._notifyStreamResuming(connection);
      }
      connection.send(
        JSON.stringify({
          type: MSG_CHAT_MESSAGES,
          messages: this.messages
        })
      );
      return _onConnect(connection, ctx);
    };

    const _onClose = this.onClose.bind(this);
    this.onClose = async (
      connection: Connection,
      code: number,
      reason: string,
      wasClean: boolean
    ) => {
      this._pendingResumeConnections.delete(connection.id);
      this._continuation.awaitingConnections.delete(connection.id);
      if (this._continuation.pending?.connectionId === connection.id) {
        this._continuation.pending = null;
      }
      if (this._continuation.activeConnectionId === connection.id) {
        this._continuation.activeConnectionId = null;
      }
      return _onClose(connection, code, reason, wasClean);
    };

    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      if (typeof message === "string") {
        const event = parseProtocolMessage(message);
        if (event) {
          await this._handleProtocolEvent(connection, event);
          return;
        }
      }
      return _onMessage(connection, message);
    };

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = async (request: Request) => {
      const url = new URL(request.url);
      if (
        url.pathname === "/get-messages" ||
        url.pathname.endsWith("/get-messages")
      ) {
        return Response.json(this.messages);
      }
      return _onRequest(request);
    };
  }

  private async _handleProtocolEvent(
    connection: Connection,
    event: NonNullable<ReturnType<typeof parseProtocolMessage>>
  ): Promise<void> {
    switch (event.type) {
      case "stream-resume-request":
        this._handleStreamResumeRequest(connection);
        break;

      case "stream-resume-ack":
        this._handleStreamResumeAck(connection, event.id);
        break;

      case "chat-request":
        if (event.init?.method === "POST") {
          await this._handleChatRequest(connection, event);
        }
        break;

      case "tool-result": {
        if (
          event.clientTools &&
          Array.isArray(event.clientTools) &&
          event.clientTools.length > 0
        ) {
          this._lastClientTools = event.clientTools as ClientToolSchema[];
          this._persistClientTools();
        }
        const resultPromise = Promise.resolve().then(() => {
          this._applyToolResult(
            event.toolCallId,
            event.output,
            event.state as "output-error" | undefined,
            event.errorText
          );
          return true;
        });
        this._pendingInteractionPromise = resultPromise;
        resultPromise
          .finally(() => {
            if (this._pendingInteractionPromise === resultPromise) {
              this._pendingInteractionPromise = null;
            }
          })
          .catch(() => {});
        if (event.autoContinue) {
          this._scheduleAutoContinuation(connection);
        }
        break;
      }

      case "tool-approval": {
        const approvalPromise = Promise.resolve().then(() => {
          this._applyToolApproval(event.toolCallId, event.approved);
          return true;
        });
        this._pendingInteractionPromise = approvalPromise;
        approvalPromise
          .finally(() => {
            if (this._pendingInteractionPromise === approvalPromise) {
              this._pendingInteractionPromise = null;
            }
          })
          .catch(() => {});
        if (event.autoContinue) {
          this._scheduleAutoContinuation(connection);
        }
        break;
      }

      case "clear":
        this._handleClear(connection);
        break;

      case "cancel":
        this._aborts.cancel(event.id);
        break;

      case "messages":
        break;
    }
  }

  private _handleStreamResumeRequest(connection: Connection): void {
    if (this._resumableStream.hasActiveStream()) {
      if (
        this._continuation.activeRequestId ===
          this._resumableStream.activeRequestId &&
        this._continuation.activeConnectionId !== null &&
        this._continuation.activeConnectionId !== connection.id
      ) {
        connection.send(JSON.stringify({ type: MSG_STREAM_RESUME_NONE }));
      } else {
        this._notifyStreamResuming(connection);
      }
    } else if (
      this._continuation.pending !== null &&
      this._continuation.pending.connectionId === connection.id
    ) {
      this._continuation.awaitingConnections.set(connection.id, connection);
    } else {
      connection.send(JSON.stringify({ type: MSG_STREAM_RESUME_NONE }));
    }
  }

  private _handleStreamResumeAck(
    connection: Connection,
    requestId: string
  ): void {
    this._pendingResumeConnections.delete(connection.id);
    if (
      this._resumableStream.hasActiveStream() &&
      this._resumableStream.activeRequestId === requestId
    ) {
      const orphanedStreamId = this._resumableStream.replayChunks(
        connection,
        this._resumableStream.activeRequestId
      );
      if (orphanedStreamId) {
        this._persistOrphanedStream(orphanedStreamId);
      }
    }
  }

  private async _handleChatRequest(
    connection: Connection,
    event: Extract<
      NonNullable<ReturnType<typeof parseProtocolMessage>>,
      { type: "chat-request" }
    >
  ) {
    if (!event.init?.body) return;

    let rawParsed: Record<string, unknown>;
    try {
      rawParsed = JSON.parse(event.init.body) as Record<string, unknown>;
    } catch {
      return;
    }

    const {
      messages: incomingMessages,
      clientTools: rawClientTools,
      trigger: rawTrigger,
      ...customBody
    } = rawParsed as {
      messages?: UIMessage[];
      clientTools?: ClientToolSchema[];
      trigger?: string;
      [key: string]: unknown;
    };
    if (!Array.isArray(incomingMessages)) return;

    const isRegeneration = rawTrigger === "regenerate-message";
    const isSubmitMessage = !isRegeneration;
    const requestId = event.id;

    // ── Concurrency decision (before persisting anything) ────────
    const concurrencyDecision =
      this._getSubmitConcurrencyDecision(isSubmitMessage);

    if (concurrencyDecision.action === "drop") {
      this._rollbackDroppedSubmit(connection);
      this._completeSkippedRequest(connection, requestId);
      return;
    }

    // ── Persist client tools and body (only for accepted requests) ──
    const requestClientTools =
      rawClientTools && rawClientTools.length > 0 ? rawClientTools : undefined;
    if (requestClientTools) {
      this._lastClientTools = requestClientTools;
      this._persistClientTools();
    } else if (rawClientTools !== undefined) {
      this._lastClientTools = undefined;
      this._persistClientTools();
    }

    const requestBody =
      Object.keys(customBody).length > 0 ? customBody : undefined;
    this._lastBody = requestBody;
    this._persistBody();

    // ── Persist and broadcast user messages ──────────────────────
    const clientToolsForTurn = this._lastClientTools;
    const bodyForTurn = this._lastBody;

    let branchParentId: string | undefined;
    if (isRegeneration && incomingMessages.length > 0) {
      branchParentId = incomingMessages[incomingMessages.length - 1].id;
    }

    for (const msg of incomingMessages) {
      await this.session.appendMessage(msg);
    }

    this._broadcastMessages([connection.id]);

    // ── Enter turn queue ────────────────────────────────────────
    const abortSignal = this._aborts.getSignal(requestId);
    const epoch = this._turnQueue.generation;

    try {
      await this.keepAliveWhile(async () => {
        const turnResult = await this._turnQueue.enqueue(
          requestId,
          async () => {
            // Superseded by a later overlapping submit (latest/merge/debounce)
            if (this._isSupersededSubmit(concurrencyDecision.submitSequence)) {
              this._completeSkippedRequest(connection, requestId);
              return;
            }

            // Debounce: wait for quiet period
            if (concurrencyDecision.debounceUntilMs !== null) {
              await this._waitForTimestamp(concurrencyDecision.debounceUntilMs);

              if (this._turnQueue.generation !== epoch) {
                this._completeSkippedRequest(connection, requestId);
                return;
              }
              if (
                this._isSupersededSubmit(concurrencyDecision.submitSequence)
              ) {
                this._completeSkippedRequest(connection, requestId);
                return;
              }
            }

            const chatTurnBody = async () => {
              const result = await agentContext.run(
                {
                  agent: this,
                  connection,
                  request: undefined,
                  email: undefined
                },
                () =>
                  this._runInferenceLoop({
                    signal: abortSignal,
                    clientTools: clientToolsForTurn,
                    body: bodyForTurn,
                    continuation: false
                  })
              );

              if (result) {
                await this._streamResult(requestId, result, abortSignal, {
                  parentId: branchParentId
                });
              } else {
                this._broadcastChat({
                  type: MSG_CHAT_RESPONSE,
                  id: requestId,
                  body: "No response was generated.",
                  done: true
                });
              }
            };

            if (this.chatRecovery) {
              await this.runFiber(
                `${(this.constructor as typeof Think).CHAT_FIBER_NAME}:${requestId}`,
                async () => {
                  await chatTurnBody();
                }
              );
            } else {
              await chatTurnBody();
            }
          }
        );

        if (turnResult.status === "stale") {
          this._broadcastChat({
            type: MSG_CHAT_RESPONSE,
            id: requestId,
            body: "",
            done: true
          });
        }
      });
    } catch (error) {
      this._broadcastChat({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: error instanceof Error ? error.message : "Error",
        done: true,
        error: true
      });
    } finally {
      this._aborts.remove(requestId);
    }
  }

  /**
   * Abort the active turn, invalidate queued turns, and reset
   * concurrency/continuation state. Call this when intercepting
   * clear events or implementing custom reset logic.
   *
   * Does NOT clear messages, streams, or persisted state —
   * only turn execution state.
   */
  protected resetTurnState(): void {
    this._turnQueue.reset();
    this._aborts.destroyAll();
    if (this._continuationTimer) {
      clearTimeout(this._continuationTimer);
      this._continuationTimer = null;
    }
    this._cancelActiveDebounce();
    this._pendingInteractionPromise = null;
    this._continuation.sendResumeNone();
    this._continuation.clearAll();
  }

  private _handleClear(connection?: Connection) {
    this.resetTurnState();

    this._resumableStream.clearAll();
    this._pendingResumeConnections.clear();
    this._lastClientTools = undefined;
    this._persistClientTools();
    this._lastBody = undefined;
    this._persistBody();
    this.session.clearMessages();
    this._broadcast(
      { type: MSG_CHAT_CLEAR },
      connection ? [connection.id] : undefined
    );
  }

  private async _streamResult(
    requestId: string,
    result: StreamableResult,
    abortSignal?: AbortSignal,
    options?: { continuation?: boolean; parentId?: string }
  ) {
    const clearGen = this._turnQueue.generation;
    const streamId = this._resumableStream.start(requestId);
    const continuation = options?.continuation ?? false;
    const parentId = options?.parentId;

    if (this._continuation.pending?.requestId === requestId) {
      this._continuation.activatePending();
      this._continuation.flushAwaitingConnections((c) =>
        this._notifyStreamResuming(c as Connection)
      );
    }

    const accumulator = new StreamAccumulator({
      messageId: crypto.randomUUID()
    });

    let doneSent = false;
    let streamAborted = false;
    let streamError: string | undefined;

    try {
      this._insideInferenceLoop = true;
      try {
        for await (const chunk of result.toUIMessageStream()) {
          if (abortSignal?.aborted) {
            streamAborted = true;
            break;
          }

          const { action } = accumulator.applyChunk(
            chunk as unknown as StreamChunkData
          );

          if (action?.type === "error") {
            this._broadcastChat({
              type: MSG_CHAT_RESPONSE,
              id: requestId,
              body: action.error,
              done: false,
              error: true
            });
            continue;
          }

          const chunkBody = JSON.stringify(chunk);
          this._resumableStream.storeChunk(streamId, chunkBody);
          this._broadcastChat({
            type: MSG_CHAT_RESPONSE,
            id: requestId,
            body: chunkBody,
            done: false
          });
        }
      } finally {
        this._insideInferenceLoop = false;
      }

      this._resumableStream.complete(streamId);
      this._pendingResumeConnections.clear();
      this._broadcastChat({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: "",
        done: true
      });
      doneSent = true;
    } catch (error) {
      streamError = error instanceof Error ? error.message : "Stream error";
      this._resumableStream.markError(streamId);
      this._pendingResumeConnections.clear();
      if (!doneSent) {
        this._broadcastChat({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: streamError,
          done: true,
          error: true
        });
        doneSent = true;
      }
    } finally {
      if (!doneSent) {
        this._resumableStream.markError(streamId);
        this._pendingResumeConnections.clear();
        this._broadcastChat({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: "",
          done: true
        });
      }
    }

    if (
      accumulator.parts.length > 0 &&
      this._turnQueue.generation === clearGen
    ) {
      try {
        const assistantMsg = accumulator.toMessage();
        this._persistAssistantMessage(assistantMsg, parentId);
        this._broadcastMessages();

        await this._fireResponseHook({
          message: assistantMsg,
          requestId,
          continuation,
          status: streamAborted
            ? "aborted"
            : streamError
              ? "error"
              : "completed",
          error: streamError
        });
      } catch (e) {
        console.error("Failed to persist assistant message:", e);
      }
    }
  }

  // ── Session-backed persistence ──────────────────────────────────

  private _persistAssistantMessage(msg: UIMessage, parentId?: string): void {
    const sanitized = sanitizeMessage(msg);
    const safe = enforceRowSizeLimit(sanitized);

    const existing = this.session.getMessage(safe.id);
    if (existing) {
      this.session.updateMessage(safe);
    } else {
      // appendMessage is async due to potential auto-compaction, but
      // we fire-and-forget here since the message write itself is synchronous
      // in AgentSessionProvider — only the optional compaction is async.
      // parentId is set for regeneration — the new response branches from
      // the same parent as the old one rather than appending to the latest leaf.
      void this.session.appendMessage(safe, parentId);
    }
  }

  private _persistClientTools(): void {
    if (this._lastClientTools) {
      this._configSet("lastClientTools", JSON.stringify(this._lastClientTools));
    } else {
      this._configDelete("lastClientTools");
    }
  }

  private _restoreClientTools(): void {
    const raw = this._configGet("lastClientTools");
    if (raw) {
      try {
        this._lastClientTools = JSON.parse(raw);
      } catch {
        this._lastClientTools = undefined;
      }
    }
  }

  private _persistBody(): void {
    if (this._lastBody) {
      this._configSet("lastBody", JSON.stringify(this._lastBody));
    } else {
      this._configDelete("lastBody");
    }
  }

  private _restoreBody(): void {
    const raw = this._configGet("lastBody");
    if (raw) {
      try {
        this._lastBody = JSON.parse(raw);
      } catch {
        this._lastBody = undefined;
      }
    }
  }

  // ── Tool state updates (shared primitives from agents/chat) ─────

  private _applyToolResult(
    toolCallId: string,
    output: unknown,
    overrideState?: "output-error",
    errorText?: string
  ): void {
    const update = toolResultUpdate(
      toolCallId,
      output,
      overrideState,
      errorText
    );
    this._applyToolUpdateToMessages(update);
  }

  private _applyToolApproval(toolCallId: string, approved: boolean): void {
    const update = toolApprovalUpdate(toolCallId, approved);
    this._applyToolUpdateToMessages(update);
  }

  private _applyToolUpdateToMessages(update: {
    toolCallId: string;
    matchStates: string[];
    apply: (part: Record<string, unknown>) => Record<string, unknown>;
  }): void {
    const history = this.messages;
    for (const msg of history) {
      const result = applyToolUpdate(
        msg.parts as Array<Record<string, unknown>>,
        update
      );
      if (result) {
        const updatedMsg = {
          ...msg,
          parts: result.parts as UIMessage["parts"]
        };
        const safe = enforceRowSizeLimit(sanitizeMessage(updatedMsg));
        this.session.updateMessage(safe);
        this._broadcast({ type: MSG_MESSAGE_UPDATED, message: safe });
        return;
      }
    }
  }

  // ── Stability + pending interactions ─────────────────────────────

  protected hasPendingInteraction(): boolean {
    return this.messages.some(
      (message) =>
        message.role === "assistant" &&
        this._messageHasPendingInteraction(message)
    );
  }

  protected async waitUntilStable(options?: {
    timeout?: number;
  }): Promise<boolean> {
    const deadline =
      options?.timeout != null ? Date.now() + options.timeout : null;

    while (true) {
      if (
        (await this._awaitWithDeadline(
          this._turnQueue.waitForIdle(),
          deadline
        )) === TIMED_OUT
      ) {
        return false;
      }

      if (!this.hasPendingInteraction()) {
        return true;
      }

      const pending = this._pendingInteractionPromise;
      if (pending) {
        let result: boolean | typeof TIMED_OUT;
        try {
          result = await this._awaitWithDeadline(pending, deadline);
        } catch {
          continue;
        }
        if (result === TIMED_OUT) {
          return false;
        }
      } else {
        if (
          (await this._awaitWithDeadline(
            new Promise<void>((resolve) => setTimeout(resolve, 100)),
            deadline
          )) === TIMED_OUT
        ) {
          return false;
        }
      }
    }
  }

  private async _awaitWithDeadline<T>(
    promise: Promise<T>,
    deadline: number | null
  ): Promise<T | typeof TIMED_OUT> {
    if (deadline == null) {
      return promise;
    }
    const remainingMs = Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), remainingMs);
      })
    ]);
    clearTimeout(timer!);
    return result;
  }

  private _messageHasPendingInteraction(message: UIMessage): boolean {
    return message.parts.some(
      (part) =>
        "state" in part &&
        ((part as Record<string, unknown>).state === "input-available" ||
          (part as Record<string, unknown>).state === "approval-requested")
    );
  }

  // ── Chat recovery via fibers ───────────────────────────────────

  protected override async _handleInternalFiberRecovery(
    ctx: FiberRecoveryContext
  ): Promise<boolean> {
    const chatPrefix = (this.constructor as typeof Think).CHAT_FIBER_NAME + ":";
    if (!ctx.name.startsWith(chatPrefix)) {
      return false;
    }

    const requestId = ctx.name.slice(chatPrefix.length);

    let streamId = "";
    if (requestId) {
      const rows = this.sql<{ id: string }>`
        SELECT id FROM cf_ai_chat_stream_metadata
        WHERE request_id = ${requestId}
        ORDER BY created_at DESC LIMIT 1
      `;
      if (rows.length > 0) {
        streamId = rows[0].id;
      }
    }
    if (!streamId && this._resumableStream.hasActiveStream()) {
      streamId = this._resumableStream.activeStreamId ?? "";
    }

    const partial = streamId
      ? this._getPartialStreamText(streamId)
      : { text: "", parts: [] as MessagePart[] };

    const options = await this.onChatRecovery({
      streamId: streamId ?? "",
      requestId,
      partialText: partial.text,
      partialParts: partial.parts,
      recoveryData: ctx.snapshot,
      messages: [...this.messages],
      lastBody: this._lastBody,
      lastClientTools: this._lastClientTools,
      createdAt: ctx.createdAt
    });

    const streamStillActive =
      streamId &&
      this._resumableStream.hasActiveStream() &&
      this._resumableStream.activeStreamId === streamId;

    if (options.persist !== false && streamStillActive) {
      this._persistOrphanedStream(streamId);
    }

    if (streamStillActive) {
      this._resumableStream.complete(streamId);
    }

    if (options.continue !== false) {
      const lastLeaf = this.session.getLatestLeaf();
      const targetId = lastLeaf?.role === "assistant" ? lastLeaf.id : undefined;
      await this.schedule(
        0,
        "_chatRecoveryContinue",
        targetId ? { targetAssistantId: targetId } : undefined,
        { idempotent: true }
      );
    }

    return true;
  }

  protected async onChatRecovery(
    _ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    return {};
  }

  async _chatRecoveryContinue(data?: {
    targetAssistantId?: string;
  }): Promise<void> {
    const ready = await this.waitUntilStable({ timeout: 10_000 });
    if (!ready) {
      console.warn(
        "[Think] _chatRecoveryContinue timed out waiting for stable state, skipping continuation"
      );
      return;
    }

    const targetId = data?.targetAssistantId;
    const lastLeaf = this.session.getLatestLeaf();
    if (targetId && lastLeaf?.id !== targetId) {
      return;
    }

    await this.continueLastTurn();
  }

  private _getPartialStreamText(streamId: string): {
    text: string;
    parts: MessagePart[];
  } {
    const chunks = this._resumableStream.getStreamChunks(streamId);
    const parts: MessagePart[] = [];

    for (const chunk of chunks) {
      try {
        const data = JSON.parse(chunk.body);
        applyChunkToParts(parts, data);
      } catch {
        // skip malformed chunks
      }
    }

    const text = parts
      .filter(
        (p): p is MessagePart & { type: "text"; text: string } =>
          p.type === "text" && "text" in p
      )
      .map((p) => p.text)
      .join("");

    return { text, parts };
  }

  // ── Concurrency strategies ──────────────────────────────────────

  private _normalizeMessageConcurrency(): NormalizedMessageConcurrency {
    if (typeof this.messageConcurrency === "string") {
      return this.messageConcurrency;
    }
    const debounceMs = this.messageConcurrency.debounceMs;
    return {
      strategy: "debounce",
      debounceMs:
        typeof debounceMs === "number" &&
        Number.isFinite(debounceMs) &&
        debounceMs >= 0
          ? debounceMs
          : Think.MESSAGE_DEBOUNCE_MS
    };
  }

  private _getSubmitConcurrencyDecision(
    isSubmitMessage: boolean
  ): SubmitConcurrencyDecision {
    const queuedTurns = this._turnQueue.queuedCount();

    if (!isSubmitMessage || queuedTurns === 0) {
      return {
        action: "execute",
        submitSequence: null,
        debounceUntilMs: null
      };
    }

    const concurrency = this._normalizeMessageConcurrency();

    if (concurrency === "queue") {
      return {
        action: "execute",
        submitSequence: null,
        debounceUntilMs: null
      };
    }

    if (concurrency === "drop") {
      return {
        action: "drop",
        submitSequence: null,
        debounceUntilMs: null
      };
    }

    const submitSequence = ++this._submitSequence;
    this._latestOverlappingSubmitSequence = submitSequence;

    if (concurrency === "latest" || concurrency === "merge") {
      return {
        action: "execute",
        submitSequence,
        debounceUntilMs: null
      };
    }

    return {
      action: "execute",
      submitSequence,
      debounceUntilMs: Date.now() + concurrency.debounceMs
    };
  }

  private _isSupersededSubmit(submitSequence: number | null): boolean {
    return (
      submitSequence !== null &&
      submitSequence < this._latestOverlappingSubmitSequence
    );
  }

  private async _waitForTimestamp(timestampMs: number): Promise<void> {
    const remainingMs = timestampMs - Date.now();
    if (remainingMs <= 0) return;

    await new Promise<void>((resolve) => {
      this._activeDebounceResolve = resolve;
      this._activeDebounceTimer = setTimeout(() => {
        this._activeDebounceTimer = null;
        this._activeDebounceResolve = null;
        resolve();
      }, remainingMs);
    });
  }

  private _cancelActiveDebounce(): void {
    if (this._activeDebounceTimer !== null) {
      clearTimeout(this._activeDebounceTimer);
      this._activeDebounceTimer = null;
    }
    if (this._activeDebounceResolve !== null) {
      this._activeDebounceResolve();
      this._activeDebounceResolve = null;
    }
  }

  private _completeSkippedRequest(
    connection: Connection,
    requestId: string
  ): void {
    connection.send(
      JSON.stringify({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: "",
        done: true
      })
    );
  }

  private _rollbackDroppedSubmit(connection: Connection): void {
    connection.send(
      JSON.stringify({
        type: MSG_CHAT_MESSAGES,
        messages: this.messages
      })
    );
  }

  // ── Auto-continuation ──────────────────────────────────────────

  private _scheduleAutoContinuation(connection: Connection): void {
    if (this._continuation.pending?.pastCoalesce) {
      this._continuation.deferred = {
        connection,
        connectionId: connection.id,
        clientTools: this._lastClientTools,
        body: undefined,
        errorPrefix: "[Think] Auto-continuation failed:",
        prerequisite: null
      };
      return;
    }

    if (this._continuation.pending) {
      this._continuation.pending.connection = connection;
      this._continuation.pending.connectionId = connection.id;
      this._continuation.pending.clientTools = this._lastClientTools;
      this._continuation.awaitingConnections.set(connection.id, connection);
      return;
    }

    if (this._continuationTimer) {
      clearTimeout(this._continuationTimer);
    }
    this._continuationTimer = setTimeout(() => {
      this._continuationTimer = null;
      this._fireAutoContinuation(connection);
    }, 50);
  }

  private _fireAutoContinuation(connection: Connection): void {
    if (!this._continuation.pending) {
      const requestId = crypto.randomUUID();
      this._continuation.pending = {
        connection,
        connectionId: connection.id,
        requestId,
        clientTools: this._lastClientTools,
        body: undefined,
        errorPrefix: "[Think] Auto-continuation failed:",
        prerequisite: null,
        pastCoalesce: false
      };
      this._continuation.awaitingConnections.set(connection.id, connection);
    }

    const { requestId, clientTools } = this._continuation.pending!;
    const abortSignal = this._aborts.getSignal(requestId);

    this.keepAliveWhile(async () => {
      await this._turnQueue.enqueue(requestId, async () => {
        if (this._continuation.pending) {
          this._continuation.pending.pastCoalesce = true;
        }
        let streamed = false;
        try {
          const continuationBody = async () => {
            const result = await agentContext.run(
              {
                agent: this,
                connection,
                request: undefined,
                email: undefined
              },
              () =>
                this._runInferenceLoop({
                  signal: abortSignal,
                  clientTools,
                  body: this._lastBody,
                  continuation: true
                })
            );
            if (result) {
              await this._streamResult(requestId, result, abortSignal, {
                continuation: true
              });
              streamed = true;
            }
          };

          if (this.chatRecovery) {
            await this.runFiber(
              `${(this.constructor as typeof Think).CHAT_FIBER_NAME}:${requestId}`,
              async () => {
                await continuationBody();
              }
            );
          } else {
            await continuationBody();
          }
        } finally {
          this._aborts.remove(requestId);
          if (!streamed) {
            this._continuation.sendResumeNone();
          }
          this._continuation.clearPending();
          this._activateDeferredContinuation();
        }
      });
    }).catch((error) => {
      console.error("[Think] Auto-continuation failed:", error);
      this._aborts.remove(requestId);
    });
  }

  private _activateDeferredContinuation(): void {
    const pending = this._continuation.activateDeferred(() =>
      crypto.randomUUID()
    );
    if (!pending) return;

    this._fireAutoContinuation(pending.connection as Connection);
  }

  // ── Response hook ──────────────────────────────────────────────

  private async _fireResponseHook(result: ChatResponseResult): Promise<void> {
    if (this._insideResponseHook) return;
    this._insideResponseHook = true;
    try {
      await this.onChatResponse(result);
    } catch (err) {
      console.error("[Think] onChatResponse error:", err);
    } finally {
      this._insideResponseHook = false;
    }
  }

  // ── Resume helpers ──────────────────────────────────────────────

  private _notifyStreamResuming(connection: Connection): void {
    if (!this._resumableStream.hasActiveStream()) return;
    this._pendingResumeConnections.add(connection.id);
    connection.send(
      JSON.stringify({
        type: MSG_STREAM_RESUMING,
        id: this._resumableStream.activeRequestId
      })
    );
  }

  private _persistOrphanedStream(streamId: string): void {
    this._resumableStream.flushBuffer();
    const chunks = this._resumableStream.getStreamChunks(streamId);
    if (chunks.length === 0) return;

    const accumulator = new StreamAccumulator({
      messageId: crypto.randomUUID()
    });
    for (const chunk of chunks) {
      try {
        accumulator.applyChunk(JSON.parse(chunk.body) as StreamChunkData);
      } catch {
        // skip malformed chunks
      }
    }

    if (accumulator.parts.length > 0) {
      this._persistAssistantMessage(accumulator.toMessage());
      this._broadcastMessages();
    }
  }

  private _broadcastChat(message: Record<string, unknown>, exclude?: string[]) {
    const allExclusions = [
      ...(exclude || []),
      ...this._pendingResumeConnections
    ];
    this.broadcast(JSON.stringify(message), allExclusions);
  }

  private _broadcast(message: Record<string, unknown>, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  private _broadcastMessages(exclude?: string[]) {
    this._broadcast(
      { type: MSG_CHAT_MESSAGES, messages: this.messages },
      exclude
    );
  }
}
