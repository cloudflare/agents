import type { LanguageModelV4 } from "@ai-sdk/provider";
import { Workspace } from "@cloudflare/shell";
import { generateText } from "ai";
import { LifecycleCapability } from "agents/lifecycle";
import {
  createCompactFunction,
  type Session,
  type SessionMessage,
  type Sessions
} from "agents/sessions";
import { Streams, type StreamWriter } from "agents/streams";
import { Tasks, type TaskStep } from "agents/tasks";
import type { WebSocketsOptions } from "agents/websockets";
import codexKernelModule from "../wasm-kernel/target/wasm32-unknown-unknown/release/codex_worker_kernel.wasm";
import { DirectKernelRuntime } from "./kernel-runtime";
import { completeCodexModel, type ModelTranscript } from "./language-model-v4";
import { CodexTransport } from "./transport";
import type { CodexSessionSnapshot, CodexWorkspaceFile } from "./protocol";
import type {
  KernelAction,
  KernelCheckpoint,
  KernelCommand,
  KernelEffectResult,
  KernelJson,
  KernelRuntime,
  KernelTransition
} from "./kernel-types";

const DRIVER_DEFINITION = "__cf_codex_drive_v1";
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
/** Bytes of a tool output shown in its event; the message holds it all. */
const PREVIEW_BYTES = 512;
/** Default page returned by workspace_read when the model gives no range. */
const DEFAULT_READ_BYTES = 256 * 1024;
/** Retry policy for one effect step; model providers fail transiently. */
const MODEL_ROUND_RETRIES = {
  limit: 4,
  delay: "2 seconds",
  backoff: "exponential"
} as const;
/** Bytes of the prompt kept on the operation row; Sessions holds it all. */
const PROMPT_PREVIEW_BYTES = 4 * 1024;

/** Input accepted by one durable harness operation. */
export type CodexPromptInput = {
  readonly prompt: string;
  readonly operationId?: string;
};

/** Receipt proving an operation and its wake were accepted. */
export type CodexSubmissionReceipt = {
  readonly operationId: string;
  readonly streamId: string;
  readonly accepted: boolean;
};

/** Point-in-time view of a harness operation. */
export type CodexOperationSnapshot = {
  readonly operationId: string;
  readonly streamId: string;
  readonly status: "queued" | "running" | "completed" | "failed";
  /** The prompt, or its first kilobytes; `promptMessageId` holds it all. */
  readonly prompt: string;
  readonly promptMessageId: string;
  readonly checkpoint: KernelCheckpoint | null;
  readonly action: KernelAction | null;
  readonly transitions: number;
  readonly kernelMs: number;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly output?: string;
  readonly error?: string;
};

type OperationRow = {
  operation_id: string;
  stream_id: string;
  status: CodexOperationSnapshot["status"];
  prompt: string;
  checkpoint: string | null;
  action: string | null;
  transitions: number;
  kernel_ms: number;
  started_at: number;
  completed_at: number | null;
  output: string | null;
  error: string | null;
};

type DriverInput = { operationId: string };

/** Dependencies the host composes around a Codex harness. */
export type CodexHarnessOptions = {
  /** Durable wake and attempt journal capability. */
  readonly tasks: Tasks;
  /** Durable operation event stream capability. */
  readonly streams: Streams;
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

/**
 * Worker-only Codex-derived harness hosted as a Lifecycle capability.
 *
 * The Rust/Wasm kernel is a pure cursor over one turn: which effect comes
 * next and which tool calls are pending. Everything with size lives in the
 * SDK's durable primitives: the transcript in Sessions, each operation's
 * events in Streams, model and tool effects journaled by reference through
 * Tasks steps, and files in the Workspace. Nothing here truncates.
 */
export class CodexHarness extends LifecycleCapability {
  private readonly tasks: Tasks;
  private readonly streams: Streams;
  private readonly workspace: Workspace;
  private readonly kernel: KernelRuntime;
  private readonly model: LanguageModelV4;
  private readonly session: Session;
  private readonly maxRounds: number;
  private readonly promptBytes: number;
  private readonly writers = new Map<string, StreamWriter>();
  private transport: CodexTransport | undefined;
  /** Demo file the UI shows; tools may write anywhere in the Workspace. */
  static readonly DEMO_FILE = "/codex/result.txt";

  constructor(options: CodexHarnessOptions) {
    super("codex-harness");
    this.tasks = options.tasks;
    this.streams = options.streams;
    this.workspace = options.workspace;
    this.kernel = new DirectKernelRuntime(codexKernelModule);
    this.model = options.model;
    this.maxRounds = options.maxRounds ?? 128;
    this.promptBytes = options.promptBytes ?? DEFAULT_PROMPT_BYTES;
    this.session = options.sessions.session();
    if (options.compaction !== false) {
      const policy = options.compaction ?? {};
      this.session
        .onCompaction(
          createCompactFunction({
            summarize: async (prompt) =>
              (await generateText({ model: this.model, prompt })).text,
            keepRecentTokens:
              policy.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS
          })
        )
        .compactAfter(policy.afterTokens ?? DEFAULT_COMPACT_AFTER_TOKENS);
    }
    options.tasks.register(DRIVER_DEFINITION, (input, step) =>
      this.#drive(parseDriverInput(input), step)
    );
  }

  /** Create the operation table owned by this capability. */
  override onStart(): void {
    this.lifecycle.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_codex_operations (
        operation_id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        checkpoint TEXT,
        action TEXT,
        transitions INTEGER NOT NULL DEFAULT 0,
        kernel_ms REAL NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        output TEXT,
        error TEXT
      );
    `);
  }

  /** Durably accept one prompt and queue its Lifecycle wake. */
  async submit(input: CodexPromptInput): Promise<CodexSubmissionReceipt> {
    await this.lifecycle.ready();
    const prompt = input.prompt.trim();
    if (prompt.length === 0) throw new Error("Codex prompt must not be empty");
    const operationId = input.operationId ?? crypto.randomUUID();
    const streamId = `codex:${operationId}`;
    const existing = this.#operation(operationId);
    if (existing) {
      if (existing.prompt !== promptPreview(prompt)) {
        throw new Error(
          `Codex operation ${operationId} already exists with different input`
        );
      }
      // The row is written before the wake is enqueued, so a retry after an
      // enqueue failure must re-sync the wake instead of stranding the turn.
      if (existing.status === "queued") await this.#enqueueDriver(operationId);
      return { operationId, streamId: existing.stream_id, accepted: false };
    }

    // The prompt joins the transcript first: Sessions chunks a large message
    // across rows, so there is no size to enforce here.
    await this.session.appendMessage({
      id: userMessageId(operationId),
      role: "user",
      parts: [{ type: "text", text: prompt }],
      metadata: { operationId }
    });
    await this.streams.open(streamId, { tag: operationId });
    this.lifecycle.storage.sql.exec(
      `INSERT INTO cf_codex_operations
       (operation_id, stream_id, status, prompt, started_at)
       VALUES (?, ?, 'queued', ?, ?)`,
      operationId,
      streamId,
      promptPreview(prompt),
      Date.now()
    );
    await this.#enqueueDriver(operationId);
    const accepted = this.#requiredOperation(operationId);
    this.transport?.operationChanged(projectSnapshot(accepted));
    return { operationId, streamId, accepted: true };
  }

  #enqueueDriver(operationId: string): Promise<unknown> {
    // Tasks dedupes on runId, so re-enqueueing an accepted operation is safe.
    return this.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
      DRIVER_DEFINITION,
      { operationId },
      { runId: `codex:${operationId}`, metadata: { operationId } }
    );
  }

  /** Bytes of Wasm linear memory the kernel currently holds. */
  kernelMemoryBytes(): Promise<number> {
    return this.kernel.memoryBytes();
  }

  /** Every operation in this session, oldest first, without kernel state. */
  async list(): Promise<CodexOperationSnapshot[]> {
    await this.lifecycle.ready();
    return [
      ...this.lifecycle.storage.sql.exec<OperationRow>(
        `SELECT operation_id, stream_id, status, prompt, NULL AS checkpoint,
                NULL AS action, transitions, kernel_ms, started_at,
                completed_at, output, error
         FROM cf_codex_operations ORDER BY started_at, operation_id`
      )
    ].map(projectSnapshot);
  }

  /** Read one Workspace file for the UI. */
  async readFile(path: string): Promise<CodexWorkspaceFile> {
    const content = await this.workspace.readFile(path);
    return content === null
      ? { path, found: false }
      : { path, found: true, content };
  }

  /** Read one transcript message, such as a tool call's arguments or output. */
  async message(id: string): Promise<SessionMessage | null> {
    await this.lifecycle.ready();
    return this.session.getMessage(id);
  }

  /** Everything a connecting client needs. */
  async sessionSnapshot(): Promise<CodexSessionSnapshot> {
    return {
      operations: await this.list(),
      file: await this.readFile(CodexHarness.DEMO_FILE)
    };
  }

  /**
   * Options for a `WebSockets` capability serving this harness's protocol:
   * `new WebSockets(this.codex.webSockets({ restart }))`.
   */
  webSockets(options: { restart(): void }): WebSocketsOptions {
    this.transport ??= new CodexTransport(
      {
        streams: this.streams,
        snapshot: () => this.sessionSnapshot(),
        submit: (input) => this.submit(input),
        operation: (operationId) => this.snapshot(operationId),
        message: (id) => this.message(id),
        readFile: (path) => this.readFile(path),
        restart: options.restart
      },
      () => this.lifecycle.sockets
    );
    return this.transport.webSocketOptions();
  }

  /** Inspect one operation and its serialized kernel state. */
  async snapshot(operationId: string): Promise<CodexOperationSnapshot | null> {
    await this.lifecycle.ready();
    const row = this.#operation(operationId);
    return row ? projectSnapshot(row) : null;
  }

  /** Read one operation's durable events from its stream. */
  async events(operationId: string, from = 0): Promise<KernelJson[]> {
    await this.lifecycle.ready();
    const row = this.#operation(operationId);
    if (!row) return [];
    const events: KernelJson[] = [];
    for await (const chunk of this.streams.read(row.stream_id, { from })) {
      events.push(chunk.chunk as KernelJson);
    }
    return events;
  }

  async #drive(input: DriverInput, step: TaskStep): Promise<KernelJson> {
    await step.status("Running Codex kernel");
    let operation = this.#requiredOperation(input.operationId);
    const writer = await this.#writer(operation);
    if (operation.status === "completed" || operation.status === "failed") {
      this.#settleStream(writer, operation);
      return projectTaskResult(operation);
    }

    this.lifecycle.storage.sql.exec(
      "UPDATE cf_codex_operations SET status = 'running' WHERE operation_id = ? AND status = 'queued'",
      operation.operation_id
    );
    this.#broadcast(operation.operation_id);

    try {
      let command: KernelCommand;
      if (operation.checkpoint === null) {
        command = {
          type: "start_turn",
          thread_id: `thread:${operation.operation_id}`,
          turn_id: `turn:${operation.operation_id}`,
          model: this.model.modelId
        };
      } else {
        const checkpoint = parseCheckpoint(operation.checkpoint);
        const action = parseAction(operation.action);
        if (action.type === "completed" || action.type === "failed") {
          // The previous incarnation recorded the terminal transition but was
          // interrupted before settling the row. Settle it now.
          if (action.type === "completed") {
            this.#settleCompleted(operation.operation_id, action.output);
          } else {
            this.#settleFailed(operation.operation_id, action.message);
          }
          operation = this.#requiredOperation(input.operationId);
          this.#settleStream(writer, operation);
          return projectTaskResult(operation);
        }
        command = {
          type: "resolve_effect",
          checkpoint,
          effect_id: action.effect_id,
          result: await this.#performEffect(operation, checkpoint, action, step)
        };
      }

      for (;;) {
        operation = this.#requiredOperation(input.operationId);
        if (
          command.type === "resolve_effect" &&
          command.checkpoint.model_round >= this.maxRounds
        ) {
          throw new Error(
            `Codex turn exceeded ${this.maxRounds} model rounds without finishing`
          );
        }
        const started = performance.now();
        const transition = await this.kernel.transition(command);
        const elapsed = performance.now() - started;
        this.#recordTransition(operation, transition, elapsed, writer);
        operation = this.#requiredOperation(input.operationId);

        if (transition.action.type === "completed") {
          this.#settleCompleted(
            operation.operation_id,
            transition.action.output
          );
          operation = this.#requiredOperation(input.operationId);
          this.#settleStream(writer, operation);
          return projectTaskResult(operation);
        }
        if (transition.action.type === "failed") {
          this.#settleFailed(operation.operation_id, transition.action.message);
          operation = this.#requiredOperation(input.operationId);
          this.#settleStream(writer, operation);
          return projectTaskResult(operation);
        }

        const result = await this.#performEffect(
          operation,
          transition.checkpoint,
          transition.action,
          step
        );
        command = {
          type: "resolve_effect",
          checkpoint: transition.checkpoint,
          effect_id: transition.action.effect_id,
          result
        };
        await step.status(
          transition.action.type === "model"
            ? "Processing Codex model response"
            : `Running ${transition.action.name}`
        );
      }
    } catch (error) {
      // Tasks signals a step retry, a suspension, or a superseded attempt by
      // throwing a control value; those must reach Tasks, not settle the turn.
      if (
        !(error instanceof Error) ||
        error.name === "AttemptSupersededError"
      ) {
        throw error;
      }
      this.#settleFailed(input.operationId, errorMessage(error));
      operation = this.#requiredOperation(input.operationId);
      this.#settleStream(writer, operation);
      return projectTaskResult(operation);
    }
  }

  /**
   * Run one kernel-requested effect as a journaled Tasks step. The step
   * stores its payload in Sessions and returns only what the kernel needs,
   * so a journaled result stays small however large the payload was. A
   * settled effect replays its stored result instead of running again; an
   * effect interrupted mid-flight re-runs, and its Sessions writes are
   * idempotent on message id.
   */
  #performEffect(
    operation: OperationRow,
    checkpoint: KernelCheckpoint,
    action: Extract<KernelAction, { type: "model" | "tool" }>,
    step: TaskStep
  ): Promise<KernelEffectResult> {
    // A provider hiccup (capacity, a dropped stream) must not fail the turn:
    // the step retries with backoff, and the turn fails only after that.
    return step.do(
      `effect:${action.effect_id}`,
      { retries: MODEL_ROUND_RETRIES, timeout: "10 minutes" },
      ({ signal }) => this.#runEffect(operation, checkpoint, action, signal)
    );
  }

  async #runEffect(
    operation: OperationRow,
    checkpoint: KernelCheckpoint,
    action: Extract<KernelAction, { type: "model" | "tool" }>,
    signal: AbortSignal
  ): Promise<KernelEffectResult> {
    {
      if (action.type === "model") {
        const round = await completeCodexModel(
          this.model,
          action,
          assistantMessageId(operation.operation_id, checkpoint.model_round),
          this.#transcript(),
          signal
        );
        return round.result;
      }
      return this.#performTool(operation, action);
    }
  }

  #transcript(): ModelTranscript {
    return {
      history: async () =>
        (await this.session.getRecentHistory(this.promptBytes)).messages,
      record: async (message) => {
        await this.session.appendMessage(message);
      }
    };
  }

  /** Run one Workspace tool and store its output as a transcript message. */
  async #performTool(
    operation: OperationRow,
    action: Extract<KernelAction, { type: "tool" }>
  ): Promise<KernelEffectResult> {
    const input = await this.#toolInput(action);
    const outcome = await performWorkspaceTool(this.workspace, action, input);
    const messageId = toolMessageId(operation.operation_id, action.call_id);
    await this.session.appendMessage({
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
      metadata: { operationId: operation.operation_id }
    });
    return {
      type: "tool",
      success: outcome.success,
      output: {
        messageId,
        bytes: byteLength(JSON.stringify(outcome.output)),
        preview: preview(outcome.output)
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
    const message = await this.session.getMessage(pointer.$message);
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

  /**
   * Record one transition and append its events to the operation's Streams
   * log in the same transaction. Events already past the writer's cursor
   * were appended by an earlier attempt and are skipped.
   */
  #recordTransition(
    operation: OperationRow,
    transition: KernelTransition,
    elapsedMs: number,
    writer: StreamWriter
  ): void {
    this.lifecycle.storage.transactionSync(() => {
      for (const event of transition.events) {
        if (event.seq < writer.cursor) continue;
        if (event.seq !== writer.cursor) {
          throw new Error(
            `Codex event gap for ${operation.operation_id}: expected ${writer.cursor}, got ${event.seq}`
          );
        }
        writer.append(event);
      }
      this.lifecycle.storage.sql.exec(
        `UPDATE cf_codex_operations
         SET checkpoint = ?, action = ?, transitions = transitions + 1,
             kernel_ms = kernel_ms + ?
         WHERE operation_id = ?`,
        JSON.stringify(transition.checkpoint),
        JSON.stringify(transition.action),
        elapsedMs,
        operation.operation_id
      );
    });
  }

  async #writer(operation: OperationRow): Promise<StreamWriter> {
    let writer = this.writers.get(operation.operation_id);
    if (!writer) {
      writer = await this.streams.open(operation.stream_id);
      this.writers.set(operation.operation_id, writer);
    }
    return writer;
  }

  #settleStream(writer: StreamWriter, operation: OperationRow): void {
    if (operation.status === "failed")
      writer.error(operation.error ?? undefined);
    else writer.close();
    this.writers.delete(operation.operation_id);
  }

  #settleCompleted(operationId: string, output: string): void {
    this.lifecycle.storage.sql.exec(
      `UPDATE cf_codex_operations
       SET status = 'completed', output = ?, completed_at = ?
       WHERE operation_id = ? AND status NOT IN ('completed', 'failed')`,
      output,
      Date.now(),
      operationId
    );
    this.#broadcast(operationId);
  }

  #settleFailed(operationId: string, error: string): void {
    this.lifecycle.storage.sql.exec(
      `UPDATE cf_codex_operations
       SET status = 'failed', error = ?, completed_at = ?
       WHERE operation_id = ? AND status NOT IN ('completed', 'failed')`,
      error,
      Date.now(),
      operationId
    );
    this.#broadcast(operationId);
  }

  #broadcast(operationId: string): void {
    const row = this.#operation(operationId);
    if (row) this.transport?.operationChanged(projectSnapshot(row));
  }

  #operation(operationId: string): OperationRow | undefined {
    return [
      ...this.lifecycle.storage.sql.exec<OperationRow>(
        "SELECT * FROM cf_codex_operations WHERE operation_id = ?",
        operationId
      )
    ][0];
  }

  #requiredOperation(operationId: string): OperationRow {
    const row = this.#operation(operationId);
    if (!row) throw new Error(`Codex operation ${operationId} does not exist`);
    return row;
  }
}

function userMessageId(operationId: string): string {
  return `${operationId}:user`;
}

function assistantMessageId(operationId: string, round: number): string {
  return `${operationId}:assistant:${round}`;
}

function toolMessageId(operationId: string, callId: string): string {
  return `${operationId}:tool:${callId}`;
}

function parseDriverInput(value: unknown): DriverInput {
  if (!isRecord(value) || typeof value.operationId !== "string") {
    throw new Error("Invalid Codex driver input");
  }
  return { operationId: value.operationId };
}

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

function projectSnapshot(row: OperationRow): CodexOperationSnapshot {
  return {
    operationId: row.operation_id,
    streamId: row.stream_id,
    status: row.status,
    prompt: row.prompt,
    promptMessageId: userMessageId(row.operation_id),
    checkpoint:
      row.checkpoint === null ? null : parseCheckpoint(row.checkpoint),
    action: row.action === null ? null : parseAction(row.action),
    transitions: row.transitions,
    kernelMs: row.kernel_ms,
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.error === null ? {} : { error: row.error })
  };
}

function projectTaskResult(row: OperationRow): KernelJson {
  return {
    operationId: row.operation_id,
    status: row.status,
    transitions: row.transitions
  };
}

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
    const offset = clampInteger(input.offset, 0, bytes.byteLength);
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

function promptPreview(prompt: string): string {
  return prompt.length > PROMPT_PREVIEW_BYTES
    ? `${prompt.slice(0, PROMPT_PREVIEW_BYTES)}…`
    : prompt;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
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
