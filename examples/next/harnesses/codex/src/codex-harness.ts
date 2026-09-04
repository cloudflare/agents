import type { LanguageModelV4 } from "@ai-sdk/provider";
import { Workspace } from "@cloudflare/shell";
import { LifecycleCapability } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { Tasks, type TaskStep } from "agents/tasks";
import codexKernelModule from "../wasm-kernel/target/wasm32-unknown-unknown/release/codex_worker_kernel.wasm";
import type { WebSocketsOptions } from "agents/websockets";
import { DirectKernelRuntime } from "./kernel-runtime";
import { completeCodexModel } from "./language-model-v4";
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
/** Model rounds one turn may take before the harness fails it. */
const MAX_MODEL_ROUNDS = 24;
/** Kernel transitions per turn: a start, each round, and each tool call. */
const MAX_TRANSITIONS = 256;
/**
 * Largest prompt, tool argument, or tool output the harness accepts. Every
 * transition writes the whole checkpoint back to SQLite in one row, so the
 * transcript must stay well inside the 2 MB row limit, and a journaled
 * effect result must fit the 1 MB Tasks step limit.
 */
const MAX_PAYLOAD_BYTES = 256 * 1024;

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
  readonly prompt: string;
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

type EventRow = { seq: number; event: string };
type DriverInput = { operationId: string };

/** Dependencies the host composes around a Codex harness. */
export type CodexHarnessOptions = {
  /** Durable wake and attempt journal capability. */
  readonly tasks: Tasks;
  /** Durable operation event stream capability. */
  readonly streams: Streams;
  /** Durable filesystem the Codex tools operate on. */
  readonly workspace: Workspace;
  /** AI SDK LanguageModelV4 used for every Codex round. */
  readonly model: LanguageModelV4;
};

/**
 * Worker-only Codex-derived harness hosted as a Lifecycle capability.
 *
 * The capability owns durable operation state. The Rust/Wasm kernel is pure
 * and asks the capability to perform model or Workspace effects, each run as
 * a journaled Tasks step so a replayed attempt reuses settled results. Tasks
 * supplies wake delivery, Streams supplies replayable output, and Workspace
 * remains a filesystem with no harness or session responsibilities.
 */
export class CodexHarness extends LifecycleCapability {
  private readonly tasks: Tasks;
  private readonly streams: Streams;
  private readonly workspace: Workspace;
  private readonly kernel: KernelRuntime;
  private readonly model: LanguageModelV4;
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
    options.tasks.register(DRIVER_DEFINITION, (input, step) =>
      this.#drive(parseDriverInput(input), step)
    );
  }

  /** Create tables owned by this capability. */
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
      CREATE TABLE IF NOT EXISTS cf_codex_events (
        operation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event TEXT NOT NULL,
        PRIMARY KEY (operation_id, seq)
      ) WITHOUT ROWID;
    `);
  }

  /** Durably accept one prompt and queue its Lifecycle wake. */
  async submit(input: CodexPromptInput): Promise<CodexSubmissionReceipt> {
    await this.lifecycle.ready();
    const prompt = input.prompt.trim();
    if (prompt.length === 0) throw new Error("Codex prompt must not be empty");
    if (byteLength(prompt) > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `Codex prompt exceeds ${MAX_PAYLOAD_BYTES} bytes; send a shorter prompt`
      );
    }
    const operationId = input.operationId ?? crypto.randomUUID();
    const streamId = `codex:${operationId}`;
    const existing = this.#operation(operationId);
    if (existing) {
      if (existing.prompt !== prompt) {
        throw new Error(
          `Codex operation ${operationId} already exists with different input`
        );
      }
      // The row is written before the wake is enqueued, so a retry after an
      // enqueue failure must re-sync the wake instead of stranding the turn.
      if (existing.status === "queued") await this.#enqueueDriver(operationId);
      return { operationId, streamId: existing.stream_id, accepted: false };
    }

    await this.streams.open(streamId, { tag: operationId });
    this.lifecycle.storage.sql.exec(
      `INSERT INTO cf_codex_operations
       (operation_id, stream_id, status, prompt, started_at)
       VALUES (?, ?, 'queued', ?, ?)`,
      operationId,
      streamId,
      prompt,
      Date.now()
    );
    await this.#enqueueDriver(operationId);
    const accepted = this.#requiredOperation(operationId);
    this.transport?.operationChanged(projectSnapshot(accepted));
    return { operationId, streamId, accepted: true };
  }

  /** Bytes of Wasm linear memory the kernel currently holds. */
  kernelMemoryBytes(): Promise<number> {
    return this.kernel.memoryBytes();
  }

  /**
   * Every operation in this session, oldest first, without kernel state.
   * Checkpoints hold the whole transcript, so a session listing must not
   * load or send them; `snapshot(operationId)` reads one on demand.
   */
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
        readFile: (path) => this.readFile(path),
        restart: options.restart
      },
      () => this.lifecycle.sockets
    );
    return this.transport.webSocketOptions();
  }

  #enqueueDriver(operationId: string): Promise<unknown> {
    // Tasks dedupes on runId, so re-enqueueing an accepted operation is safe.
    return this.tasks.__DO_NOT_USE_WILL_BREAK__enqueue(
      DRIVER_DEFINITION,
      { operationId },
      { runId: `codex:${operationId}`, metadata: { operationId } }
    );
  }

  /** Inspect one operation and its serialized kernel state. */
  async snapshot(operationId: string): Promise<CodexOperationSnapshot | null> {
    await this.lifecycle.ready();
    const row = this.#operation(operationId);
    return row ? projectSnapshot(row) : null;
  }

  /** Read the durable event journal currently available without tailing. */
  async events(operationId: string, from = 0): Promise<KernelJson[]> {
    await this.lifecycle.ready();
    if (!this.#operation(operationId)) return [];
    return [
      ...this.lifecycle.storage.sql.exec<EventRow>(
        `SELECT seq, event FROM cf_codex_events
         WHERE operation_id = ? AND seq >= ? ORDER BY seq`,
        operationId,
        from
      )
    ].map((row) => parseKernelJson(row.event));
  }

  async #drive(input: DriverInput, step: TaskStep): Promise<KernelJson> {
    await step.status("Running Codex kernel");
    let operation = this.#requiredOperation(input.operationId);
    if (operation.status === "completed" || operation.status === "failed") {
      // Replayed after settling: make sure the stream is closed and finish.
      await this.#flushEvents(operation, true);
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
          prompt: operation.prompt,
          model: this.model.modelId
        };
      } else {
        const checkpoint = parseCheckpoint(operation.checkpoint);
        const action = parseAction(operation.action, checkpoint);
        if (action.type === "completed" || action.type === "failed") {
          // The previous incarnation recorded the terminal transition but was
          // interrupted before settling the row. Settle it now.
          if (action.type === "completed") {
            this.#settleCompleted(operation.operation_id, action.output);
          } else {
            this.#settleFailed(operation.operation_id, action.message);
          }
          operation = this.#requiredOperation(input.operationId);
          await this.#flushEvents(operation, true);
          return projectTaskResult(operation);
        }
        const effectResult = await this.#performEffect(action, step);
        command = {
          type: "resolve_effect",
          checkpoint,
          effect_id: action.effect_id,
          result: effectResult
        };
      }

      for (;;) {
        operation = this.#requiredOperation(input.operationId);
        if (operation.transitions >= MAX_TRANSITIONS) {
          throw new Error(`Codex turn exceeded ${MAX_TRANSITIONS} transitions`);
        }
        if (
          command.type === "resolve_effect" &&
          command.checkpoint.model_round >= MAX_MODEL_ROUNDS
        ) {
          throw new Error(
            `Codex turn exceeded ${MAX_MODEL_ROUNDS} model rounds without finishing`
          );
        }
        const started = performance.now();
        const transition = await this.kernel.transition(command);
        const elapsed = performance.now() - started;
        this.#recordTransition(operation, transition, elapsed);
        operation = this.#requiredOperation(input.operationId);
        await this.#flushEvents(operation);

        if (transition.action.type === "completed") {
          this.#settleCompleted(
            operation.operation_id,
            transition.action.output
          );
          operation = this.#requiredOperation(input.operationId);
          await this.#flushEvents(operation, true);
          return projectTaskResult(operation);
        }
        if (transition.action.type === "failed") {
          this.#settleFailed(operation.operation_id, transition.action.message);
          operation = this.#requiredOperation(input.operationId);
          await this.#flushEvents(operation, true);
          return projectTaskResult(operation);
        }

        const result = await this.#performEffect(transition.action, step);
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
      const message = error instanceof Error ? error.message : String(error);
      this.#settleFailed(input.operationId, message);
      operation = this.#requiredOperation(input.operationId);
      await this.#flushEvents(operation, true);
      return projectTaskResult(operation);
    }
  }

  /**
   * Run one kernel-requested effect as a journaled Tasks step. A settled
   * effect replays its stored result instead of running again, and the
   * attempt's signal cancels in-flight model calls when the run is cancelled.
   *
   * An effect interrupted mid-flight is re-run on the next attempt. Workspace
   * tools are idempotent, and a model round that finished after its isolate
   * died is accepted as a rare duplicate call rather than failing the turn.
   */
  #performEffect(
    action: Extract<KernelAction, { type: "model" | "tool" }>,
    step: TaskStep
  ): Promise<KernelEffectResult> {
    return step.do(`effect:${action.effect_id}`, ({ signal }) =>
      action.type === "model"
        ? completeCodexModel(this.model, action, signal)
        : performWorkspaceTool(this.workspace, action)
    );
  }

  #recordTransition(
    operation: OperationRow,
    transition: KernelTransition,
    elapsedMs: number
  ): void {
    this.lifecycle.storage.transactionSync(() => {
      for (const event of transition.events) {
        this.lifecycle.storage.sql.exec(
          `INSERT OR IGNORE INTO cf_codex_events (operation_id, seq, event)
           VALUES (?, ?, ?)`,
          operation.operation_id,
          event.seq,
          JSON.stringify(event)
        );
      }
      this.lifecycle.storage.sql.exec(
        `UPDATE cf_codex_operations
         SET checkpoint = ?, action = ?, transitions = transitions + 1,
             kernel_ms = kernel_ms + ?
         WHERE operation_id = ?`,
        JSON.stringify(transition.checkpoint),
        JSON.stringify(storedAction(transition.action)),
        elapsedMs,
        operation.operation_id
      );
    });
  }

  async #flushEvents(operation: OperationRow, settle = false): Promise<void> {
    const writer = await this.streams.open(operation.stream_id);
    const rows = [
      ...this.lifecycle.storage.sql.exec<EventRow>(
        `SELECT seq, event FROM cf_codex_events
         WHERE operation_id = ? AND seq >= ? ORDER BY seq`,
        operation.operation_id,
        writer.cursor
      )
    ];
    for (const row of rows) {
      if (row.seq !== writer.cursor) {
        throw new Error(
          `Codex event gap for ${operation.operation_id}: expected ${writer.cursor}, got ${row.seq}`
        );
      }
      writer.append(parseKernelJson(row.event));
    }
    if (settle) {
      if (operation.status === "failed")
        writer.error(operation.error ?? undefined);
      else writer.close();
    }
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

/**
 * A model action's request repeats the checkpoint's whole input. Storing it
 * twice per transition doubled the row and halved the transcript a turn could
 * carry, so the stored copy drops `request.input` and it is rehydrated from
 * the checkpoint on read.
 */
function storedAction(action: KernelAction): KernelJson {
  if (action.type !== "model" || !isRecord(action.request)) return action;
  return { ...action, request: { ...action.request, input: null } };
}

function parseAction(
  value: string | null,
  checkpoint: KernelCheckpoint
): KernelAction {
  if (value === null) throw new Error("Stored Codex operation has no action");
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new Error("Stored Codex action is malformed");
  }
  if (parsed.type === "model" && isRecord(parsed.request)) {
    parsed.request = { ...parsed.request, input: checkpoint.input };
  }
  // SAFETY: The Rust kernel is the only action writer and its discriminator
  // was checked before narrowing to the shared action union.
  return parsed as KernelAction;
}

function parseKernelJson(value: string): KernelJson {
  // SAFETY: Rust serialized this value from KernelEvent, which contains only
  // JSON-compatible fields.
  return JSON.parse(value) as KernelJson;
}

function projectSnapshot(row: OperationRow): CodexOperationSnapshot {
  return {
    operationId: row.operation_id,
    streamId: row.stream_id,
    status: row.status,
    prompt: row.prompt,
    checkpoint:
      row.checkpoint === null ? null : parseCheckpoint(row.checkpoint),
    action:
      row.action === null || row.checkpoint === null
        ? null
        : parseAction(row.action, parseCheckpoint(row.checkpoint)),
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

async function performWorkspaceTool(
  workspace: Workspace,
  action: Extract<KernelAction, { type: "tool" }>
): Promise<KernelEffectResult> {
  if (!isRecord(action.arguments)) {
    return {
      type: "error",
      message: `${action.name} arguments must be an object`
    };
  }
  if (typeof action.arguments.error === "string") {
    // The codec replaced oversized arguments; hand the reason to the model.
    return {
      type: "tool",
      success: false,
      output: { error: action.arguments.error }
    };
  }
  const path = action.arguments.path;
  if (typeof path !== "string") {
    return { type: "error", message: `${action.name} requires a path` };
  }
  if (action.name === "workspace_write") {
    const content = action.arguments.content;
    if (typeof content !== "string") {
      return { type: "error", message: "workspace_write requires content" };
    }
    if (byteLength(content) > MAX_PAYLOAD_BYTES) {
      return {
        type: "tool",
        success: false,
        output: {
          path,
          error: `content exceeds ${MAX_PAYLOAD_BYTES} bytes; write it in smaller files`
        }
      };
    }
    await workspace.writeFile(path, content);
    return {
      type: "tool",
      success: true,
      output: { path, bytes: new TextEncoder().encode(content).byteLength }
    };
  }
  if (action.name === "workspace_read") {
    const content = await workspace.readFile(path);
    if (content !== null && byteLength(content) > MAX_PAYLOAD_BYTES) {
      return {
        type: "tool",
        success: false,
        output: {
          path,
          bytes: byteLength(content),
          error: `file exceeds ${MAX_PAYLOAD_BYTES} bytes; it cannot be read into the transcript`
        }
      };
    }
    return {
      type: "tool",
      success: content !== null,
      output: content === null ? { path, found: false } : { path, content }
    };
  }
  return { type: "error", message: `Unknown Codex tool ${action.name}` };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
