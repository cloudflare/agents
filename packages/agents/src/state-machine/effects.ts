import { randomAlphanumeric } from "./ids";
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
    kind: string,
    input: Input,
    options: MachineEffectPlanOptions
  ): MachineEffectRef<Output> {
    const activeEffects = this.#store
      .effectsForRun(row.run_id)
      .filter(
        (effect) => effect.status === "pending" || effect.status === "running"
      ).length;
    if (activeEffects + pending.length >= MAX_ACTIVE_EFFECTS) {
      throw new Error(
        `Machine run "${row.run_id}" has too many active effects`
      );
    }
    const id = `effect_${randomAlphanumeric()}`;
    pending.push({
      id,
      kind,
      input,
      recovery: options.recovery,
      externalId: options.externalId
    });
    return { id, kind, recovery: options.recovery };
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
           external_id, result_json, error_name, error_message, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, ?, NULL)`,
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
    effect: MachineEffectRef<Output>
  ): Promise<MachineEffectOutcome<Output>> {
    let row = this.#store.getEffect(runId, effect.id);
    if (!row) throw new Error(`Unknown Machine effect "${effect.id}"`);
    if (row.status === "completed") {
      return {
        status: "completed",
        output: deserializeMachineValue(row.result_json) as Output
      };
    }
    if (row.status === "failed") {
      return {
        status: "failed",
        error: {
          name: row.error_name ?? "Error",
          message: row.error_message ?? "Machine effect failed"
        }
      };
    }
    if (row.status === "interrupted") return { status: "interrupted" };

    const runtime = this.#runtimes[row.kind];
    if (!runtime) {
      throw new Error(`No runtime registered for Machine effect "${row.kind}"`);
    }
    const wasRunning = row.status === "running";
    if (wasRunning && row.recovery === "never") {
      this.#markInterrupted(runId, effect.id);
      return { status: "interrupted" };
    }
    if (wasRunning && row.recovery === "reconcile") {
      if (!row.external_id || !runtime.reconcile) {
        this.#markInterrupted(runId, effect.id);
        return { status: "interrupted" };
      }
      const controller = new AbortController();
      const reconciled = await runtime.reconcile(row.external_id, {
        effectId: row.effect_id,
        idempotencyKey: `${runId}:${row.effect_id}`,
        externalId: row.external_id,
        signal: controller.signal
      });
      if (reconciled.status === "running") return { status: "running" };
      if (reconciled.status === "completed") {
        this.#settleCompleted(runId, effect.id, reconciled.output);
        return { status: "completed", output: reconciled.output as Output };
      }
      if (reconciled.status === "failed") {
        this.#settleFailed(runId, effect.id, reconciled.error);
        return { status: "failed", error: reconciled.error };
      }
      this.#markInterrupted(runId, effect.id);
      return { status: "interrupted" };
    }

    this.#store.write(
      `UPDATE cf_agents_state_machine_effects SET status = 'running'
       WHERE run_id = ? AND effect_id = ? AND status IN ('pending', 'running')`,
      [runId, effect.id]
    );
    row = this.#store.getEffect(runId, effect.id)!;
    this.#emit("state-machine:effect:started", {
      runId,
      effectId: effect.id,
      kind: row.kind
    });
    const controller = new AbortController();
    const controllerKey = `${runId}:${effect.id}`;
    this.#controllers.set(controllerKey, controller);
    try {
      const output = await runtime.execute(JSON.parse(row.input_json), {
        effectId: row.effect_id,
        idempotencyKey: `${runId}:${row.effect_id}`,
        ...(row.external_id ? { externalId: row.external_id } : {}),
        signal: controller.signal
      });
      this.#settleCompleted(runId, effect.id, output);
      return { status: "completed", output: output as Output };
    } catch (error) {
      const summary = errorSummary(error);
      this.#settleFailed(runId, effect.id, summary);
      return { status: "failed", error: summary };
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

  #settleCompleted(
    runId: string,
    effectId: string,
    output: MachineValue
  ): void {
    const now = Date.now();
    this.#store.write(
      `UPDATE cf_agents_state_machine_effects
       SET status = 'completed', result_json = ?, settled_at = ?
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
       SET status = 'failed', error_name = ?, error_message = ?, settled_at = ?
       WHERE run_id = ? AND effect_id = ? AND status IN ('pending', 'running')`,
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
       SET status = 'interrupted', settled_at = ?
       WHERE run_id = ? AND effect_id = ? AND status = 'running'`,
      [Date.now(), runId, effectId]
    );
  }
}

function errorSummary(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}
