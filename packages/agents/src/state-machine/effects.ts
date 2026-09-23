import { isMachineEffectPending } from "./effect";
import { machineBuilderId } from "./ids";
import {
  deserializeMachineValue,
  serializeMachineValue
} from "./serialization";
import type { StateMachineStore } from "./store";
import type {
  MachineEffectOutcome,
  MachineEffectPlanOptions,
  MachineEffectRecovery,
  MachineEffectRef,
  MachineEffectRetryPolicy,
  MachineEffectRuntimes,
  MachineJson,
  MachineRunRow,
  MachineValue
} from "./types";

const MAX_ACTIVE_EFFECTS = 100;

export type PendingEffect = {
  id: string;
  kind: string;
  input: MachineJson;
  recovery: MachineEffectRecovery;
  externalId: string | undefined;
  optionsJson: string;
};

export class MachineEffectManager {
  readonly #store: StateMachineStore;
  readonly #runtimes: MachineEffectRuntimes;
  readonly #emit: (type: string, payload: unknown) => void;
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: {
    store: StateMachineStore;
    runtimes: MachineEffectRuntimes;
    emit: (type: string, payload: unknown) => void;
  }) {
    this.#store = options.store;
    this.#runtimes = options.runtimes;
    this.#emit = options.emit;
  }

  plan<Input extends MachineJson, Output extends MachineValue>(
    row: MachineRunRow,
    pending: PendingEffect[],
    ordinal: number,
    kind: string,
    input: Input,
    options: MachineEffectPlanOptions
  ): MachineEffectRef<Output> {
    validateEffectOptions(options);
    const id = machineBuilderId(
      row.run_id,
      row.builder_revision,
      "effect",
      ordinal
    );
    const inputJson =
      serializeMachineValue(input, `input for effect "${id}"`) ?? "null";
    const optionsJson = effectOptionsJson(options);
    // Re-entering a waiting phase resolves the same builder slot instead of
    // appending another row. A changed definition is a nondeterministic replay.
    const existing = this.#store.getEffect(row.run_id, id);
    if (existing) {
      if (
        existing.kind !== kind ||
        existing.recovery !== options.recovery ||
        existing.input_json !== inputJson ||
        existing.external_id !== (options.externalId ?? null) ||
        existing.options_json !== optionsJson
      ) {
        throw new Error(
          `Machine effect "${id}" was replayed with a different definition`
        );
      }
      return effectRef(id, kind, options);
    }

    const activeEffects = this.#store
      .effectsForRun(row.run_id)
      .filter((effect) =>
        ["pending", "running", "retrying"].includes(effect.status)
      ).length;
    if (activeEffects + pending.length >= MAX_ACTIVE_EFFECTS) {
      throw new Error(
        `Machine run "${row.run_id}" has too many active effects`
      );
    }
    pending.push({
      id,
      kind,
      input,
      recovery: options.recovery,
      externalId: options.externalId,
      optionsJson
    });
    return effectRef(id, kind, options);
  }

  applyPending(
    runId: string,
    revision: number,
    pending: readonly PendingEffect[],
    now: number
  ): void {
    for (const effect of pending) {
      this.#store.sql(
        `INSERT INTO cf_agents_state_machine_effects
          (run_id, effect_id, revision, kind, recovery, status, input_json,
           external_id, result_json, error_name, error_message, attempt,
           retry_at, options_json, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, 1,
                 NULL, ?, ?, NULL)`,
        runId,
        effect.id,
        revision,
        effect.kind,
        effect.recovery,
        serializeMachineValue(
          effect.input,
          `input for effect "${effect.id}"`
        ) ?? "null",
        effect.externalId ?? null,
        effect.optionsJson,
        now
      );
    }
  }

  publishPending(runId: string, pending: readonly PendingEffect[]): void {
    for (const effect of pending) {
      this.#emit("state-machine:effect:planned", {
        runId,
        effectId: effect.id,
        kind: effect.kind,
        recovery: effect.recovery
      });
    }
  }

  async execute<Output extends MachineValue>(
    runId: string,
    effect: MachineEffectRef<Output>,
    pendingEffects: readonly PendingEffect[] = []
  ): Promise<MachineEffectOutcome<Output>> {
    let row = this.#store.getEffect(runId, effect.id);
    if (!row) {
      if (pendingEffects.some((candidate) => candidate.id === effect.id)) {
        throw new Error(
          `Machine effect "${effect.kind}" was planned in this phase but not committed, so it cannot be executed yet. Return context.transition(...) to commit it and execute it in the next phase, or use context.effects.run() to plan and execute in one step.`
        );
      }
      throw new Error(`Unknown Machine effect "${effect.id}"`);
    }
    if (
      row.kind !== effect.kind ||
      row.recovery !== effect.recovery ||
      row.options_json !== effectOptionsJson(effect)
    ) {
      throw new Error(
        `Machine effect reference "${effect.id}" does not match its durable definition`
      );
    }
    const recovering = row.status === "running";
    if (row.status === "completed") {
      return {
        status: "completed",
        output: deserializeMachineValue(row.result_json) as Output,
        attempt: row.attempt
      };
    }
    if (row.status === "failed") {
      return {
        status: "failed",
        error: {
          name: row.error_name ?? "Error",
          message: row.error_message ?? "Machine effect failed"
        },
        attempt: row.attempt
      };
    }
    if (row.status === "interrupted") {
      return { status: "interrupted", attempt: row.attempt };
    }
    if (row.status === "retrying") {
      // Early wakes may re-enter the phase before the retry alarm is due.
      const retryAt = row.retry_at;
      if (retryAt === null) {
        throw new Error(
          `Retrying Machine effect "${effect.id}" has no retryAt`
        );
      }
      if (Date.now() < retryAt) {
        return { status: "retrying", attempt: row.attempt, retryAt };
      }
      this.#store.write(
        `UPDATE cf_agents_state_machine_effects
         SET status = 'running', retry_at = NULL
         WHERE run_id = ? AND effect_id = ? AND status = 'retrying'
           AND retry_at <= ?`,
        [runId, effect.id, Date.now()]
      );
      row = this.#store.getEffect(runId, effect.id)!;
      if (row.status === "retrying") {
        return {
          status: "retrying",
          attempt: row.attempt,
          retryAt: row.retry_at!
        };
      }
    }

    const runtime = this.#runtimes[row.kind];
    if (!runtime) {
      throw new Error(`No runtime registered for Machine effect "${row.kind}"`);
    }
    if (recovering && row.recovery === "never") {
      this.#markInterrupted(runId, effect.id);
      return { status: "interrupted", attempt: row.attempt };
    }
    if (recovering && row.recovery === "reconcile") {
      if (!row.external_id || !runtime.reconcile) {
        this.#markInterrupted(runId, effect.id);
        return { status: "interrupted", attempt: row.attempt };
      }
      const controllerKey = `${runId}:${effect.id}`;
      const controller = new AbortController();
      this.#controllers.set(controllerKey, controller);
      try {
        const input = JSON.parse(row.input_json);
        const reconciled = await withTimeout(
          runtime.reconcile(row.external_id, {
            effectId: row.effect_id,
            idempotencyKey: `${runId}:${row.effect_id}`,
            externalId: row.external_id,
            signal: controller.signal,
            attempt: row.attempt,
            input
          }),
          effect.timeoutMs,
          row.kind,
          controller
        );
        if (reconciled.status === "running") {
          return { status: "running", attempt: row.attempt };
        }
        if (reconciled.status === "completed") {
          this.#settleCompleted(runId, effect.id, reconciled.output);
          return {
            status: "completed",
            output: reconciled.output as Output,
            attempt: row.attempt
          };
        }
        if (reconciled.status === "failed") {
          this.#settleFailed(runId, effect.id, reconciled.error);
          return {
            status: "failed",
            error: reconciled.error,
            attempt: row.attempt
          };
        }
        this.#markInterrupted(runId, effect.id);
        return { status: "interrupted", attempt: row.attempt };
      } catch (error) {
        const summary = errorSummary(error);
        this.#settleFailed(runId, effect.id, summary);
        return { status: "failed", error: summary, attempt: row.attempt };
      } finally {
        this.#controllers.delete(controllerKey);
      }
    }

    this.#store.write(
      `UPDATE cf_agents_state_machine_effects SET status = 'running'
       WHERE run_id = ? AND effect_id = ? AND status = 'pending'`,
      [runId, effect.id]
    );
    row = this.#store.getEffect(runId, effect.id)!;
    const attempt = row.attempt;
    this.#emit("state-machine:effect:started", {
      runId,
      effectId: effect.id,
      kind: row.kind,
      attempt
    });
    const controller = new AbortController();
    const controllerKey = `${runId}:${effect.id}`;
    this.#controllers.set(controllerKey, controller);
    try {
      const input = JSON.parse(row.input_json);
      const output = await withTimeout(
        runtime.execute(input, {
          effectId: row.effect_id,
          idempotencyKey: `${runId}:${row.effect_id}`,
          ...(row.external_id ? { externalId: row.external_id } : {}),
          signal: controller.signal,
          attempt,
          input
        }),
        effect.timeoutMs,
        row.kind,
        controller
      );
      if (isMachineEffectPending(output)) {
        this.#store.write(
          `UPDATE cf_agents_state_machine_effects
           SET external_id = ?
           WHERE run_id = ? AND effect_id = ? AND status = 'running'`,
          [output.externalId, runId, effect.id]
        );
        return { status: "running", attempt };
      }
      this.#settleCompleted(runId, effect.id, output);
      return { status: "completed", output: output as Output, attempt };
    } catch (error) {
      const summary = errorSummary(error);
      const limit = Math.max(1, effect.retries?.limit ?? 1);
      if (row.recovery === "never" || attempt >= limit) {
        this.#settleFailed(runId, effect.id, summary);
        return { status: "failed", error: summary, attempt };
      }
      const delay = backoffDelay(effect.retries, attempt);
      const retryAt = Date.now() + delay;
      if (!Number.isSafeInteger(delay) || !Number.isSafeInteger(retryAt)) {
        const invalid = {
          name: "RangeError",
          message:
            "Machine effect retry deadline exceeds the safe integer range"
        };
        this.#settleFailed(runId, effect.id, invalid);
        return { status: "failed", error: invalid, attempt };
      }
      this.#store.write(
        `UPDATE cf_agents_state_machine_effects
         SET status = 'retrying', attempt = ?, retry_at = ?
         WHERE run_id = ? AND effect_id = ? AND status = 'running'`,
        [attempt + 1, retryAt, runId, effect.id]
      );
      this.#emit("state-machine:effect:retry", {
        runId,
        effectId: effect.id,
        kind: row.kind,
        attempt,
        error: summary.name,
        retryAt
      });
      return { status: "retrying", attempt: attempt + 1, retryAt };
    } finally {
      this.#controllers.delete(controllerKey);
    }
  }

  abortLive(runId: string, reason?: string): void {
    for (const [key, controller] of this.#controllers) {
      if (key.startsWith(`${runId}:`)) {
        controller.abort(new Error(reason ?? "cancelled"));
      }
    }
  }

  async cancelExternal(row: MachineRunRow): Promise<void> {
    for (const effect of this.#store.effectsForRun(row.run_id)) {
      if (effect.status !== "running" || !effect.external_id) continue;
      const runtime = this.#runtimes[effect.kind];
      if (!runtime?.cancel) continue;
      await runtime.cancel(effect.external_id, {
        effectId: effect.effect_id,
        idempotencyKey: `${row.run_id}:${effect.effect_id}`,
        externalId: effect.external_id,
        signal: AbortSignal.abort(row.cancel_reason ?? "cancelled"),
        attempt: effect.attempt,
        input: JSON.parse(effect.input_json)
      });
      this.#markInterrupted(row.run_id, effect.effect_id);
    }
  }

  #settleCompleted(
    runId: string,
    effectId: string,
    output: MachineValue
  ): void {
    const now = Date.now();
    this.#store.write(
      `UPDATE cf_agents_state_machine_effects
       SET status = 'completed', result_json = ?, retry_at = NULL, settled_at = ?
       WHERE run_id = ? AND effect_id = ? AND status IN ('pending', 'running')`,
      [
        serializeMachineValue(output, `output for effect "${effectId}"`),
        now,
        runId,
        effectId
      ]
    );
    this.#emit("state-machine:effect:completed", { runId, effectId });
  }

  #settleFailed(
    runId: string,
    effectId: string,
    error: { name: string; message: string }
  ): void {
    this.#store.write(
      `UPDATE cf_agents_state_machine_effects
       SET status = 'failed', error_name = ?, error_message = ?,
           retry_at = NULL, settled_at = ?
       WHERE run_id = ? AND effect_id = ?
         AND status IN ('pending', 'running', 'retrying')`,
      [error.name, error.message, Date.now(), runId, effectId]
    );
    this.#emit("state-machine:effect:failed", {
      runId,
      effectId,
      error: error.name
    });
  }

  #markInterrupted(runId: string, effectId: string): void {
    this.#store.write(
      `UPDATE cf_agents_state_machine_effects
       SET status = 'interrupted', retry_at = NULL, settled_at = ?
       WHERE run_id = ? AND effect_id = ? AND status = 'running'`,
      [Date.now(), runId, effectId]
    );
  }
}

function effectOptionsJson(
  options: Pick<MachineEffectPlanOptions, "timeoutMs" | "retries">
): string {
  const retries = options.retries;
  return JSON.stringify({
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(retries === undefined
      ? {}
      : {
          retries: {
            ...(retries.limit === undefined ? {} : { limit: retries.limit }),
            ...(retries.delay === undefined ? {} : { delay: retries.delay }),
            ...(retries.backoff === undefined
              ? {}
              : { backoff: retries.backoff })
          }
        })
  });
}

function effectRef<Output extends MachineValue>(
  id: string,
  kind: string,
  options: MachineEffectPlanOptions
): MachineEffectRef<Output> {
  return {
    id,
    kind,
    recovery: options.recovery,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.retries === undefined ? {} : { retries: options.retries })
  };
}

function validateEffectOptions(options: MachineEffectPlanOptions): void {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new Error(
      "Machine effect timeoutMs must be a positive finite number"
    );
  }
  if (
    options.retries?.limit !== undefined &&
    (!Number.isSafeInteger(options.retries.limit) || options.retries.limit < 1)
  ) {
    throw new Error("Machine effect retry limit must be a positive integer");
  }
  if (
    options.retries?.delay !== undefined &&
    (!Number.isFinite(options.retries.delay) || options.retries.delay < 0)
  ) {
    throw new Error(
      "Machine effect retry delay must be a non-negative finite number"
    );
  }
}

function backoffDelay(
  policy: MachineEffectRetryPolicy | undefined,
  attempt: number
): number {
  const base = policy?.delay ?? 0;
  if (base <= 0) return 0;
  const delay = Math.floor(
    policy?.backoff === "linear"
      ? base * attempt
      : policy?.backoff === "exponential"
        ? base * 2 ** (attempt - 1)
        : base
  );
  return delay;
}

/** Bound even runtimes that do not cooperate with their abort signal. */
async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number | undefined,
  kind: string,
  controller: AbortController
): Promise<T> {
  if (timeoutMs === undefined) return operation;
  let rejectTimeout: ((error: Error) => void) | undefined;
  const timer = setTimeout(() => {
    const error = new Error(
      `Machine effect "${kind}" timed out after ${timeoutMs}ms`
    );
    controller.abort(error);
    rejectTimeout?.(error);
  }, timeoutMs);
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        rejectTimeout = reject;
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errorSummary(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}
