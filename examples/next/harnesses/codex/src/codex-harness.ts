import type { LanguageModelV4 } from "@ai-sdk/provider";
import { Workspace } from "@cloudflare/shell";
import { LifecycleCapability } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { Tasks, type TaskStep } from "agents/tasks";
import codexKernelModule from "../wasm-kernel/target/wasm32-unknown-unknown/release/codex_worker_kernel.wasm";
import { DirectKernelRuntime } from "./kernel-runtime";
import { completeCodexModel } from "./language-model-v4";
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
const MAX_TRANSITIONS = 16;

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
type EffectRow = { status: "pending" | "completed"; result: string | null };
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
 * The capability owns durable operation and effect state. The Rust/Wasm kernel
 * is pure and asks the capability to perform model or Workspace effects. Tasks
 * supplies wake delivery, Streams supplies replayable output, and Workspace
 * remains a filesystem with no harness or session responsibilities.
 */
export class CodexHarness extends LifecycleCapability {
  private readonly tasks: Tasks;
  private readonly streams: Streams;
  private readonly workspace: Workspace;
  private readonly kernel: KernelRuntime;
  private readonly model: LanguageModelV4;

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
      CREATE TABLE IF NOT EXISTS cf_codex_effects (
        operation_id TEXT NOT NULL,
        effect_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        request TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY (operation_id, effect_id)
      ) WITHOUT ROWID;
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
          await this.#flushEvents(operation, true);
          return projectTaskResult(operation);
        }
        const effectResult = await this.#performEffect(operation, action);
        command = {
          type: "resolve_effect",
          checkpoint: parseCheckpoint(operation.checkpoint),
          effect_id: action.effect_id,
          result: effectResult
        };
      }

      for (;;) {
        operation = this.#requiredOperation(input.operationId);
        if (operation.transitions >= MAX_TRANSITIONS) {
          throw new Error(`Codex turn exceeded ${MAX_TRANSITIONS} transitions`);
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

        const result = await this.#performEffect(operation, transition.action);
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

  async #performEffect(
    operation: OperationRow,
    action: Extract<KernelAction, { type: "model" | "tool" }>
  ): Promise<KernelEffectResult> {
    const existing = this.#effect(operation.operation_id, action.effect_id);
    if (existing?.status === "completed" && existing.result !== null) {
      return parseEffectResult(existing.result);
    }
    if (!existing) {
      this.lifecycle.storage.sql.exec(
        `INSERT INTO cf_codex_effects
         (operation_id, effect_id, kind, status, request, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
        operation.operation_id,
        action.effect_id,
        action.type,
        JSON.stringify(action),
        Date.now()
      );
    }

    const result =
      action.type === "model"
        ? await completeCodexModel(this.model, action)
        : await performWorkspaceTool(this.workspace, action);
    this.lifecycle.storage.sql.exec(
      `UPDATE cf_codex_effects
       SET status = 'completed', result = ?, completed_at = ?
       WHERE operation_id = ? AND effect_id = ?`,
      JSON.stringify(result),
      Date.now(),
      operation.operation_id,
      action.effect_id
    );
    return result;
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
        JSON.stringify(transition.action),
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

  #effect(operationId: string, effectId: string): EffectRow | undefined {
    return [
      ...this.lifecycle.storage.sql.exec<EffectRow>(
        `SELECT status, result FROM cf_codex_effects
         WHERE operation_id = ? AND effect_id = ?`,
        operationId,
        effectId
      )
    ][0];
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

function parseEffectResult(value: string): KernelEffectResult {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new Error("Stored Codex effect result is malformed");
  }
  // SAFETY: CodexHarness is the only effect writer and writes one declared
  // KernelEffectResult variant after checking the action kind.
  return parsed as KernelEffectResult;
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
  const path = action.arguments.path;
  if (typeof path !== "string") {
    return { type: "error", message: `${action.name} requires a path` };
  }
  if (action.name === "workspace_write") {
    const content = action.arguments.content;
    if (typeof content !== "string") {
      return { type: "error", message: "workspace_write requires content" };
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
    return {
      type: "tool",
      success: content !== null,
      output: content === null ? { path, found: false } : { path, content }
    };
  }
  return { type: "error", message: `Unknown Codex tool ${action.name}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
