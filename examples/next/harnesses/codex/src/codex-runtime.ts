/**
 * `CodexRuntime`: the Codex-derived turn loop as a `HarnessRuntime`.
 *
 * The shared `Harness` owns admission, the inbox, operation rows, the event
 * logs and the Tasks driver. What is left here is what makes this harness
 * Codex: a Rust/Wasm kernel that is a pure cursor over one turn, deciding
 * which effect comes next and which tool calls are pending.
 *
 * Everything with size lives in the SDK's durable primitives. The transcript
 * is in `Sessions`, frames are in the harness's Streams logs, model and tool
 * effects are journaled by reference through Tasks steps, and files are in
 * the `Workspace`. The only state this runtime keeps of its own is one small
 * row per operation holding the kernel checkpoint, so a turn survives
 * eviction mid-flight and resumes exactly where it stopped.
 */
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Workspace } from "@cloudflare/shell";
import {
  createCompactFunction,
  type Session,
  type SessionMessagePart,
  type Sessions
} from "agents/sessions";
import { generateText } from "ai";
import type {
  HarnessCapability,
  HarnessDriveContext,
  HarnessInput,
  HarnessRuntimeMessagePage,
  HarnessMessagesOptions,
  HarnessOperationHandle,
  HarnessPromptPayload,
  HarnessRuntime,
  HarnessRuntimeStartContext,
  HarnessSettlement,
  HarnessStopReason,
  HarnessUsage,
  JsonValue
} from "@cloudflare/agents-next-harness";
import codexKernelModule from "../wasm-kernel/target/wasm32-unknown-unknown/release/codex_worker_kernel.wasm";
import { DirectKernelRuntime } from "./kernel-runtime";
import {
  completeCodexModel,
  type ModelTranscript,
  type ModelUsage
} from "./language-model-v4";
import type { CodexKernelSnapshot, CodexProtocol } from "./protocol";
import type {
  KernelAction,
  KernelCheckpoint,
  KernelCommand,
  KernelEffectResult,
  KernelJson,
  KernelRuntime,
  KernelTransition
} from "./kernel-types";

/**
 * Bytes of recent transcript hydrated for one model round. This bounds the
 * Durable Object's memory, not the model's context: parts over
 * MAX_PROMPT_PART_BYTES reach the model as markers and compaction bounds the
 * token count. 32 MiB matches Think's hydration budget.
 */
const DEFAULT_PROMPT_BYTES = 32 * 1024 * 1024;
/** Estimated tokens on the branch before Sessions compacts it. */
const DEFAULT_COMPACT_AFTER_TOKENS = 120_000;
/** Tokens kept verbatim at the tail after a compaction. */
const DEFAULT_KEEP_RECENT_TOKENS = 40_000;
/** Model rounds one turn may take before it is failed. */
const DEFAULT_MAX_ROUNDS = 128;
/** Bytes of a tool output shown in its frame; the message holds it all. */
const PREVIEW_BYTES = 512;
/** Default page returned by workspace_read when the model gives no range. */
const DEFAULT_READ_BYTES = 256 * 1024;
/** One effect step's wall clock budget. */
const EFFECT_TIMEOUT = "10 minutes";
/** Attempts one model round takes before the turn fails. */
const MODEL_ATTEMPTS = 3;
/** Delay before retrying a model round inside its step. */

/** Dependencies the host composes around the Codex runtime. */
export type CodexRuntimeOptions = {
  /** Durable transcript: every prompt, assistant message, and tool output. */
  readonly sessions: Sessions;
  /** Durable filesystem the Codex tools operate on. */
  readonly workspace: Workspace;
  /** AI SDK LanguageModelV4 used for every Codex round and for compaction. */
  readonly model: LanguageModelV4;
  /** Model rounds one turn may take before it is failed. @default 128 */
  readonly maxRounds?: number;
  /** Bytes of recent transcript hydrated per round. @default 32 MiB */
  readonly promptBytes?: number;
  /** Compaction policy; `false` disables it. */
  readonly compaction?:
    | false
    | { readonly afterTokens?: number; readonly keepRecentTokens?: number };
};

/** The kernel state of one operation. One small row, never a transcript. */
type OperationRow = {
  operation_id: string;
  checkpoint: string | null;
  action: string | null;
  event_seq: number;
  transitions: number;
  kernel_ms: number;
  input_tokens: number;
  output_tokens: number;
};

/** What one journaled effect step returns to the turn loop. */
type EffectOutcome =
  | { readonly interrupted: true }
  | { readonly result: KernelEffectResult };

/** Demo file the UI shows; tools may write anywhere in the Workspace. */
export const CODEX_DEMO_FILE = "/codex/result.txt";

export class CodexRuntime implements HarnessRuntime<CodexProtocol> {
  readonly id = "in-do:codex";
  /** Codex runs one conversation per object and never asks a question. */
  readonly capabilities = new Set<HarnessCapability>(["workspace", "usage"]);

  readonly #workspace: Workspace;
  readonly #kernel: KernelRuntime;
  readonly #model: LanguageModelV4;
  readonly #session: Session;
  readonly #maxRounds: number;
  readonly #promptBytes: number;
  #storage: DurableObjectStorage | undefined;

  constructor(options: CodexRuntimeOptions) {
    this.#workspace = options.workspace;
    this.#kernel = new DirectKernelRuntime(codexKernelModule);
    this.#model = options.model;
    this.#maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.#promptBytes = options.promptBytes ?? DEFAULT_PROMPT_BYTES;
    this.#session = options.sessions.session();
    if (options.compaction !== false) {
      const policy = options.compaction ?? {};
      this.#session
        .onCompaction(
          createCompactFunction({
            summarize: async (prompt) =>
              (await generateText({ model: this.#model, prompt })).text,
            keepRecentTokens:
              policy.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS
          })
        )
        .compactAfter(policy.afterTokens ?? DEFAULT_COMPACT_AFTER_TOKENS);
    }
  }

  onStart(ctx: HarnessRuntimeStartContext): void {
    this.#storage = ctx.storage;
    // The pre-harness example kept operation bookkeeping in this table; the
    // base owns all of that now, so a legacy table is dropped rather than
    // migrated. Only the kernel's own state survives here.
    const legacy = [
      ...ctx.storage.sql.exec<{ name: string }>(
        "SELECT name FROM pragma_table_info('cf_codex_operations') WHERE name = 'stream_id'"
      )
    ];
    if (legacy.length > 0) {
      ctx.storage.sql.exec("DROP TABLE cf_codex_operations");
    }
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_codex_operations (
        operation_id TEXT PRIMARY KEY,
        checkpoint TEXT,
        action TEXT,
        event_seq INTEGER NOT NULL DEFAULT 0,
        transitions INTEGER NOT NULL DEFAULT 0,
        kernel_ms REAL NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  /**
   * Run what the inbox asks for. An operation the base already started but
   * never settled comes first: its prompt is in the transcript and its
   * checkpoint is on the row, so the turn resumes from the effect it was
   * waiting on however it was interrupted.
   */
  async drive(ctx: HarnessDriveContext<CodexProtocol>): Promise<void> {
    for (;;) {
      if (ctx.signal.aborted) return;
      const active = ctx.active();
      if (active) {
        await this.#runTurn(ctx, active.operationId);
        continue;
      }
      const head = ctx.inbox.peek({ kinds: ["prompt"], limit: 1 })[0];
      if (!head || head.operationId === null) return;
      const operationId = head.operationId;
      const payload = head.payload as unknown as HarnessPromptPayload;
      // The prompt joins the transcript before the operation starts. Sessions
      // dedupes on message id and the admission row is still in the inbox, so
      // a crash here replays the append rather than losing the prompt.
      await this.#session.appendMessage({
        id: userMessageId(operationId),
        role: "user",
        parts: promptParts(payload.input),
        metadata: { operationId }
      });
      await this.#runTurn(ctx, operationId);
    }
  }

  /** The transcript as stored, oldest first. The base stamps `asOf`. */
  async messages(
    _sessionId: string,
    options: HarnessMessagesOptions
  ): Promise<HarnessRuntimeMessagePage> {
    const history = await this.#session.getRecentHistory(
      options.maxBytes ?? this.#promptBytes
    );
    return { messages: history.messages };
  }

  /** Tokens every model round in this object reported. */
  async usage(_sessionId: string): Promise<HarnessUsage | undefined> {
    const row = this.#sql<{ input: number; output: number }>(
      `SELECT coalesce(sum(input_tokens), 0) AS input,
              coalesce(sum(output_tokens), 0) AS output
       FROM cf_codex_operations`
    )[0];
    if (!row || (row.input === 0 && row.output === 0)) return undefined;
    return { inputTokens: row.input, outputTokens: row.output };
  }

  /** Bytes of Wasm linear memory the kernel currently holds. */
  kernelMemoryBytes(): Promise<number> {
    return this.#kernel.memoryBytes();
  }

  /** One operation's kernel state, for the demo's inspector route. */
  kernelSnapshot(operationId: string): CodexKernelSnapshot | null {
    const row = this.#row(operationId);
    if (!row) return null;
    return {
      operationId,
      checkpoint:
        row.checkpoint === null ? null : parseCheckpoint(row.checkpoint),
      action: row.action === null ? null : parseAction(row.action),
      transitions: row.transitions,
      kernelMs: row.kernel_ms
    };
  }

  /** Read one Workspace file for the demo's file route. */
  async readFile(
    path: string
  ): Promise<{ path: string; found: boolean; content?: string }> {
    const content = await this.#workspace.readFile(path);
    return content === null
      ? { path, found: false }
      : { path, found: true, content };
  }

  /** Forget this session's kernel rows; Sessions owns the transcript. */
  async delete(_sessionId: string): Promise<void> {
    // One conversation per object, so every row belongs to this session.
    this.#storage?.sql.exec("DELETE FROM cf_codex_operations");
  }

  // ── The turn loop ────────────────────────────────────────────────────────

  /**
   * Drive one operation to settlement. Replay-safe at every step: the base
   * makes `begin()` idempotent, Sessions dedupes messages on id, and each
   * effect is a named Tasks step whose result is journaled.
   */
  async #runTurn(
    ctx: HarnessDriveContext<CodexProtocol>,
    operationId: string
  ): Promise<void> {
    const handle = await ctx.begin(operationId);
    const interrupted = ctx.interrupted(operationId);
    const row = this.#row(operationId);
    let command: KernelCommand;

    if (!row || row.checkpoint === null) {
      command = {
        type: "start_turn",
        thread_id: `thread:${operationId}`,
        turn_id: `turn:${operationId}`,
        model: this.#model.modelId
      };
    } else {
      const checkpoint = parseCheckpoint(row.checkpoint);
      const action = parseAction(row.action);
      if (action.type === "completed" || action.type === "failed") {
        // A previous incarnation recorded the terminal transition but was
        // interrupted before settling. Settle it now.
        await this.#settleTerminal(ctx, operationId, action);
        return;
      }
      const outcome = await this.#effect(
        ctx,
        handle,
        operationId,
        checkpoint,
        action,
        interrupted
      );
      if ("interrupted" in outcome) {
        await this.#settleInterrupted(ctx, operationId);
        return;
      }
      command = {
        type: "resolve_effect",
        checkpoint,
        effect_id: action.effect_id,
        result: outcome.result
      };
    }

    for (;;) {
      if (interrupted.aborted) {
        await this.#settleInterrupted(ctx, operationId);
        return;
      }
      const started = performance.now();
      const transition = await this.#kernel.transition(command);
      this.#record(
        operationId,
        transition,
        performance.now() - started,
        handle
      );
      const action = transition.action;
      if (action.type === "completed" || action.type === "failed") {
        await this.#settleTerminal(ctx, operationId, action);
        return;
      }
      if (
        action.type === "model" &&
        transition.checkpoint.model_round >= this.#maxRounds
      ) {
        await this.#settle(ctx, operationId, {
          status: "failed",
          stopReason: { type: "max_turns" },
          error: {
            code: "E_MAX_ROUNDS",
            message: `Codex turn exceeded ${this.#maxRounds} model rounds without finishing`
          }
        });
        return;
      }
      const outcome = await this.#effect(
        ctx,
        handle,
        operationId,
        transition.checkpoint,
        action,
        interrupted
      );
      if ("interrupted" in outcome) {
        await this.#settleInterrupted(ctx, operationId);
        return;
      }
      command = {
        type: "resolve_effect",
        checkpoint: transition.checkpoint,
        effect_id: action.effect_id,
        result: outcome.result
      };
    }
  }

  /**
   * Run one kernel-requested effect as a journaled Tasks step, wrapped in the
   * core frames a client renders: `message_start` / `message_end` around a
   * model round, `tool_start` / `tool_end` around a tool call. The step
   * stores its payload in Sessions and returns only what the kernel needs,
   * so a journaled result stays small however large the payload was.
   */
  async #effect(
    ctx: HarnessDriveContext<CodexProtocol>,
    handle: HarnessOperationHandle<CodexProtocol>,
    operationId: string,
    checkpoint: KernelCheckpoint,
    action: Extract<KernelAction, { type: "model" | "tool" }>,
    interrupted: AbortSignal
  ): Promise<EffectOutcome> {
    if (interrupted.aborted) return { interrupted: true };
    // Names are the run's journal keys and one run drives every operation in
    // the session, so each effect is named under its operation.
    const name = `${operationId}:effect:${action.effect_id}`;
    if (action.type === "model") {
      const messageId = assistantMessageId(operationId, checkpoint.model_round);
      handle.append({ type: "message_start", messageId, role: "assistant" });
      let outcome: EffectOutcome;
      try {
        outcome = await ctx.step.do<EffectOutcome>(
          name,
          {
            retries: { limit: MODEL_ATTEMPTS, delay: "1 second" },
            timeout: EFFECT_TIMEOUT
          },
          ({ signal }) =>
            this.#modelRound(operationId, action, messageId, handle, [
              signal,
              interrupted
            ])
        );
      } catch (error) {
        // A client pairs start and end by id: close the message before the
        // failure settles the operation.
        const stored = await this.#session.getMessage(messageId);
        handle.append({
          type: "message_end",
          messageId,
          role: "assistant",
          parts: stored?.parts ?? []
        });
        throw error;
      }
      const stored = await this.#session.getMessage(messageId);
      handle.append({
        type: "message_end",
        messageId,
        role: "assistant",
        parts: stored?.parts ?? []
      });
      return outcome;
    }

    const input = await this.#toolInput(action);
    handle.append({
      type: "tool_start",
      toolCallId: action.call_id,
      toolName: action.name,
      input: asJson(input)
    });
    let outcome: EffectOutcome;
    try {
      outcome = await ctx.step.do<EffectOutcome>(
        name,
        { retries: { limit: 2, delay: "1 second" }, timeout: EFFECT_TIMEOUT },
        () => this.#toolCall(operationId, action, input)
      );
    } catch (error) {
      handle.append({
        type: "tool_end",
        toolCallId: action.call_id,
        output: {
          error: error instanceof Error ? error.message : String(error)
        },
        isError: true
      });
      throw error;
    }
    if ("interrupted" in outcome) return outcome;
    const result = outcome.result;
    handle.append({
      type: "tool_end",
      toolCallId: action.call_id,
      output: result.type === "tool" ? result.output : null,
      isError: result.type !== "tool" || !result.success
    });
    return outcome;
  }

  /**
   * One model round. Retries are the step's: a provider hiccup parks the
   * step and Tasks re-enters `drive()` after the delay, which the base lets
   * through as a control value rather than a runtime failure.
   */
  async #modelRound(
    operationId: string,
    action: Extract<KernelAction, { type: "model" }>,
    messageId: string,
    handle: HarnessOperationHandle<CodexProtocol>,
    signals: readonly AbortSignal[]
  ): Promise<EffectOutcome> {
    const signal = AbortSignal.any([...signals]);
    if (signal.aborted) return { interrupted: true };
    try {
      const round = await completeCodexModel(
        this.#model,
        action,
        messageId,
        this.#transcript(),
        {
          signal,
          onDelta: (delta) =>
            handle.preview({
              type: delta.type === "text" ? "text_delta" : "reasoning_delta",
              messageId,
              delta: delta.delta
            })
        }
      );
      this.#addUsage(operationId, round.usage);
      return { result: round.result };
    } catch (error) {
      if (signal.aborted) return { interrupted: true };
      throw error;
    }
  }

  /** Run one Workspace tool and store its output as a transcript message. */
  async #toolCall(
    operationId: string,
    action: Extract<KernelAction, { type: "tool" }>,
    input: unknown
  ): Promise<EffectOutcome> {
    const outcome = await performWorkspaceTool(this.#workspace, action, input);
    const messageId = toolMessageId(operationId, action.call_id);
    await this.#session.appendMessage({
      id: messageId,
      role: "tool",
      parts: [
        {
          type: `tool-${action.name}`,
          toolCallId: action.call_id,
          toolName: action.name,
          output: outcome.output,
          state: outcome.success ? "output-available" : "output-error"
        }
      ],
      metadata: { operationId }
    });
    return {
      result: {
        type: "tool",
        success: outcome.success,
        output: {
          messageId,
          bytes: byteLength(JSON.stringify(outcome.output)),
          preview: preview(outcome.output)
        }
      }
    };
  }

  /** Resolve a tool call's arguments from the assistant message that made it. */
  async #toolInput(
    action: Extract<KernelAction, { type: "tool" }>
  ): Promise<unknown> {
    const pointer = action.arguments;
    if (!isRecord(pointer) || typeof pointer.$message !== "string") {
      return pointer;
    }
    const message = await this.#session.getMessage(pointer.$message);
    const part = message?.parts.find(
      (candidate) => candidate.toolCallId === action.call_id
    );
    if (!part) {
      throw new Error(
        `Tool call ${action.call_id} has no stored arguments in ${pointer.$message}`
      );
    }
    return part.input;
  }

  #transcript(): ModelTranscript {
    return {
      history: async () =>
        (await this.#session.getRecentHistory(this.#promptBytes)).messages,
      record: async (message) => {
        await this.#session.appendMessage(message);
      }
    };
  }

  // ── Durable kernel state ─────────────────────────────────────────────────

  /**
   * Record one transition: its events as extension frames, then the
   * checkpoint on the operation's row. Frames are flushed before the row is
   * written, so an incarnation lost in between replays a few informational
   * kernel events rather than dropping them.
   */
  #record(
    operationId: string,
    transition: KernelTransition,
    elapsedMs: number,
    handle: HarnessOperationHandle<CodexProtocol>
  ): void {
    const recorded = this.#row(operationId)?.event_seq ?? 0;
    for (const event of transition.events) {
      if (event.seq < recorded) continue;
      handle.append({
        type: "extension",
        body: { type: "kernel_event", event: event as KernelJson }
      });
    }
    const checkpoint = transition.checkpoint;
    handle.flush();
    this.#sql(
      `INSERT INTO cf_codex_operations
         (operation_id, checkpoint, action, event_seq, transitions, kernel_ms)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(operation_id) DO UPDATE SET
         checkpoint = excluded.checkpoint,
         action = excluded.action,
         event_seq = excluded.event_seq,
         transitions = cf_codex_operations.transitions + 1,
         kernel_ms = cf_codex_operations.kernel_ms + excluded.kernel_ms`,
      operationId,
      JSON.stringify(checkpoint),
      JSON.stringify(transition.action),
      checkpoint.next_event_seq,
      elapsedMs
    );
    const row = this.#row(operationId);
    handle.append({
      type: "extension",
      body: {
        type: "kernel_checkpoint",
        phase: checkpoint.phase,
        modelRound: checkpoint.model_round,
        transitions: row?.transitions ?? 1,
        kernelMs: row?.kernel_ms ?? elapsedMs
      }
    });
  }

  /** Add one round's tokens to the operation's row, inside its step. */
  #addUsage(operationId: string, usage: ModelUsage | undefined): void {
    if (!usage) return;
    this.#sql(
      `INSERT INTO cf_codex_operations
         (operation_id, input_tokens, output_tokens)
       VALUES (?, ?, ?)
       ON CONFLICT(operation_id) DO UPDATE SET
         input_tokens = cf_codex_operations.input_tokens + excluded.input_tokens,
         output_tokens = cf_codex_operations.output_tokens + excluded.output_tokens`,
      operationId,
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0
    );
  }

  #row(operationId: string): OperationRow | undefined {
    return this.#sql<OperationRow>(
      "SELECT * FROM cf_codex_operations WHERE operation_id = ?",
      operationId
    )[0];
  }

  #sql<Row extends Record<string, SqlStorageValue>>(
    query: string,
    ...params: (string | number)[]
  ): Row[] {
    const storage = this.#storage;
    if (!storage) throw new Error("CodexRuntime was not started");
    return [...storage.sql.exec<Row>(query, ...params)];
  }

  // ── Settlement ───────────────────────────────────────────────────────────

  async #settleTerminal(
    ctx: HarnessDriveContext<CodexProtocol>,
    operationId: string,
    action: Extract<KernelAction, { type: "completed" | "failed" }>
  ): Promise<void> {
    if (action.type === "completed") {
      await this.#settle(ctx, operationId, {
        status: "completed",
        stopReason: { type: "end_turn" },
        output: action.output
      });
      return;
    }
    await this.#settle(ctx, operationId, {
      status: "failed",
      stopReason: { type: "error", raw: action.message },
      error: { code: "E_CODEX_TURN", message: action.message }
    });
  }

  async #settleInterrupted(
    ctx: HarnessDriveContext<CodexProtocol>,
    operationId: string
  ): Promise<void> {
    await this.#settle(ctx, operationId, {
      status: "aborted",
      stopReason: { type: "interrupted" }
    });
  }

  /** Settle with the kernel's own terminal record and this turn's tokens. */
  async #settle(
    ctx: HarnessDriveContext<CodexProtocol>,
    operationId: string,
    outcome: {
      readonly status: HarnessSettlement["status"];
      readonly stopReason: HarnessStopReason;
      readonly error?: { readonly code: string; readonly message: string };
      readonly output?: string;
    }
  ): Promise<void> {
    const row = this.#row(operationId);
    const usage: HarnessUsage | undefined =
      row && (row.input_tokens > 0 || row.output_tokens > 0)
        ? { inputTokens: row.input_tokens, outputTokens: row.output_tokens }
        : undefined;
    await ctx.settle(operationId, {
      status: outcome.status,
      stopReason: outcome.stopReason,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(usage === undefined ? {} : { usage }),
      raw: {
        output: outcome.output ?? null,
        transitions: row?.transitions ?? 0,
        kernelMs: row?.kernel_ms ?? 0
      }
    });
  }
}

// ── Message ids ────────────────────────────────────────────────────────────

function userMessageId(operationId: string): string {
  return `${operationId}:user`;
}

function assistantMessageId(operationId: string, round: number): string {
  return `${operationId}:assistant:${round}`;
}

function toolMessageId(operationId: string, callId: string): string {
  return `${operationId}:tool:${callId}`;
}

function promptParts(input: HarnessInput): SessionMessagePart[] {
  if (typeof input === "string") return [{ type: "text", text: input }];
  if (input.parts) return [...input.parts];
  return [{ type: "text", text: input.text ?? "" }];
}

// ── Kernel JSON ────────────────────────────────────────────────────────────

function parseCheckpoint(value: string): KernelCheckpoint {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed) || typeof parsed.version !== "number") {
    throw new Error("Stored Codex checkpoint is malformed");
  }
  // SAFETY: The Rust kernel is the only checkpoint writer. The version field
  // was checked and the full value is returned to that same versioned kernel.
  return parsed as KernelCheckpoint;
}

function parseAction(value: string | null): KernelAction {
  if (value === null) throw new Error("Stored Codex operation has no action");
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new Error("Stored Codex action is malformed");
  }
  // SAFETY: The Rust kernel is the only action writer and its discriminator
  // was checked before narrowing to the shared action union.
  return parsed as KernelAction;
}

/** Tool inputs and outputs come from parsed JSON, so they are JSON already. */
function asJson(value: unknown): JsonValue {
  // SAFETY: the value was parsed from the model's JSON arguments or written
  // by the kernel, both of which are plain JSON.
  return (value ?? null) as JsonValue;
}

// ── Workspace tools ────────────────────────────────────────────────────────

type ToolOutcome = { readonly success: boolean; readonly output: KernelJson };

async function performWorkspaceTool(
  workspace: Workspace,
  action: Extract<KernelAction, { type: "tool" }>,
  input: unknown
): Promise<ToolOutcome> {
  if (!isRecord(input)) {
    return {
      success: false,
      output: { error: `${action.name} arguments must be an object` }
    };
  }
  const path = input.path;
  if (typeof path !== "string") {
    return {
      success: false,
      output: { error: `${action.name} requires a path` }
    };
  }
  if (action.name === "workspace_write") {
    const content = input.content;
    if (typeof content !== "string") {
      return {
        success: false,
        output: { path, error: "workspace_write requires content" }
      };
    }
    await workspace.writeFile(path, content);
    return { success: true, output: { path, bytes: byteLength(content) } };
  }
  if (action.name === "workspace_read") {
    const content = await workspace.readFile(path);
    if (content === null)
      return { success: false, output: { path, found: false } };
    // Files have no size limit; the model pages through big ones by range.
    const bytes = new TextEncoder().encode(content);
    const offset = Math.min(bytes.byteLength, clampInteger(input.offset, 0, 0));
    const maxBytes = clampInteger(input.max_bytes, 1, DEFAULT_READ_BYTES);
    const end = Math.min(bytes.byteLength, offset + maxBytes);
    return {
      success: true,
      output: {
        path,
        content: new TextDecoder().decode(bytes.subarray(offset, end)),
        offset,
        end,
        total_bytes: bytes.byteLength,
        ...(end < bytes.byteLength ? { next_offset: end } : {})
      }
    };
  }
  return {
    success: false,
    output: { error: `Unknown Codex tool ${action.name}` }
  };
}

function clampInteger(value: unknown, min: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.floor(value))
    : fallback;
}

function preview(value: KernelJson): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > PREVIEW_BYTES
    ? `${text.slice(0, PREVIEW_BYTES)}…`
    : text;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
