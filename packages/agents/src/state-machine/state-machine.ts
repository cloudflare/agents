import { nanoid } from "nanoid";
import { LifecycleCapability } from "../lifecycle/capability";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../lifecycle/job-queue";
import { isPlatformFailure } from "../retries";
import {
  applyMachineCommitParticipant,
  publishMachineCommitParticipant
} from "./commit";
import {
  MachineTransitionConflictError,
  MissingMachineDefinitionError
} from "./errors";
import {
  migrateStateMachineSchema,
  STATE_MACHINE_SCHEMA_VERSION,
  STATE_MACHINE_SCHEMA_VERSION_KEY
} from "./migrations";
import {
  deserializeMachineValue,
  serializeMachineValue
} from "./serialization";
import { StateMachineStore } from "./store";
import type {
  MachineCommitParticipant,
  MachineContext,
  MachineDecision,
  MachineDefinitions,
  MachineInput,
  MachineOutput,
  MachinePhased,
  MachineReceipt,
  MachineRunOptions,
  MachineRunRow,
  MachineRunSnapshot,
  MachineState,
  MachineTransitionOptions,
  MachineValue
} from "./types";

type RuntimeDefinition = {
  version: number;
  initial: (input: MachineValue) => MachinePhased;
  phases: Record<
    string,
    (
      state: MachinePhased,
      context: MachineContext<MachinePhased, MachineValue>
    ) =>
      | MachineDecision<MachinePhased, MachineValue>
      | Promise<MachineDecision<MachinePhased, MachineValue>>
  >;
};

type DrivePayload = { runId: string; revision: number };

export interface StateMachineOptions<Definitions extends MachineDefinitions> {
  readonly definitions: Definitions;
}

/** Durable checkpointed state machines driven by Lifecycle jobs. */
export class StateMachine<
  Definitions extends MachineDefinitions = MachineDefinitions
> extends LifecycleCapability {
  readonly #definitions: Definitions;
  #storeInstance: StateMachineStore | undefined;

  constructor(options: StateMachineOptions<Definitions>) {
    super("state-machine");
    this.#definitions = options.definitions;
  }

  get #store(): StateMachineStore {
    this.#storeInstance ??= new StateMachineStore(this.lifecycle.storage);
    return this.#storeInstance;
  }

  async onStart(): Promise<void> {
    const version =
      (await this.lifecycle.storage.get<number>(
        STATE_MACHINE_SCHEMA_VERSION_KEY
      )) ?? 0;
    if (version < STATE_MACHINE_SCHEMA_VERSION) {
      migrateStateMachineSchema(this.#store);
      await this.lifecycle.storage.put(
        STATE_MACHINE_SCHEMA_VERSION_KEY,
        STATE_MACHINE_SCHEMA_VERSION
      );
    }

    this.#store.transaction(() => {
      for (const row of this.#store.listRunning()) {
        this.#pushJob(row.run_id, row.revision, Date.now());
      }
    });
  }

  async run<Name extends keyof Definitions & string>(
    definitionName: Name,
    input: MachineInput<Definitions[Name]>,
    options: MachineRunOptions = {}
  ): Promise<MachineReceipt> {
    await this.lifecycle.ready();
    const definition = this.#definition(definitionName);
    if (options.runId !== undefined && options.runId.length === 0) {
      throw new Error("Machine runId must be a non-empty string");
    }
    if (
      options.idempotencyKey !== undefined &&
      options.idempotencyKey.length === 0
    ) {
      throw new Error("Machine idempotencyKey must be a non-empty string");
    }

    const existing =
      (options.runId ? this.#store.getRun(options.runId) : undefined) ??
      (options.idempotencyKey
        ? this.#store.getRunByKey(options.idempotencyKey)
        : undefined);
    if (existing) {
      if (existing.definition !== definitionName) {
        throw new Error(
          `Machine run "${existing.run_id}" belongs to ` +
            `"${existing.definition}", not "${definitionName}"`
        );
      }
      return {
        runId: existing.run_id,
        definition: definitionName,
        accepted: false,
        createdAt: existing.created_at
      };
    }

    const initial = definition.initial(input as MachineValue);
    this.#assertState(definitionName, definition, initial);
    const checkpoint = serializeMachineValue(
      initial,
      `checkpoint for Machine definition "${definitionName}"`
    );
    const runId = options.runId ?? `machine_${nanoid()}`;
    const now = Date.now();
    const jobId = this.#jobId(runId);

    this.#store.transaction(() => {
      this.#store.insertRun({
        run_id: runId,
        definition: definitionName,
        definition_version: definition.version,
        status: "running",
        phase: initial.phase,
        checkpoint_json: checkpoint,
        revision: 0,
        control_json: '{"status":"running"}',
        job_id: jobId,
        result_json: null,
        error_name: null,
        error_message: null,
        retain: options.retain === false ? 0 : 1,
        idempotency_key: options.idempotencyKey ?? null,
        created_at: now,
        updated_at: now,
        settled_at: null
      });
      this.#pushJob(runId, 0, now);
    });
    await this.lifecycle.jobs.rearm();
    this.lifecycle.events.emit("state-machine:accepted", {
      runId,
      definition: definitionName
    });
    return {
      runId,
      definition: definitionName,
      accepted: true,
      createdAt: now
    };
  }

  async get<Name extends keyof Definitions & string>(
    runId: string,
    definition?: Name
  ): Promise<MachineRunSnapshot<
    MachineState<Definitions[Name]>,
    MachineOutput<Definitions[Name]>
  > | null> {
    await this.lifecycle.ready();
    const row = this.#store.getRun(runId);
    if (!row) return null;
    if (definition !== undefined && row.definition !== definition) return null;
    return this.#store.toSnapshot(row) as MachineRunSnapshot<
      MachineState<Definitions[Name]>,
      MachineOutput<Definitions[Name]>
    >;
  }

  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (context.job.fn !== "drive") {
      throw new Error(`Unknown StateMachine job function "${context.job.fn}"`);
    }
    const payload = context.job.payload as DrivePayload;
    if (!payload || typeof payload.runId !== "string") {
      throw new Error("Invalid StateMachine drive payload");
    }
    await this.#drive(payload);
    return undefined;
  }

  async #drive(input: DrivePayload): Promise<void> {
    const row = this.#store.getRun(input.runId);
    if (!row || row.status !== "running" || row.revision !== input.revision) {
      return;
    }
    const definition = this.#definition(row.definition);
    if (definition.version !== row.definition_version) {
      await this.#commitFailure(row, {
        name: "MachineDefinitionVersionError",
        message:
          `Machine definition "${row.definition}" is version ` +
          `${definition.version}, but run "${row.run_id}" requires ` +
          `${row.definition_version}`
      });
      return;
    }
    const state = deserializeMachineValue(row.checkpoint_json) as MachinePhased;
    this.#assertState(row.definition, definition, state);
    const handler = definition.phases[state.phase];
    if (!handler) throw new MissingMachineDefinitionError(row.definition);

    let decision: MachineDecision<MachinePhased, MachineValue>;
    try {
      decision = (await this.lifecycle.runInHostContext(() =>
        handler(state, this.#context(row))
      )) as MachineDecision<MachinePhased, MachineValue>;
    } catch (error) {
      if (isPlatformFailure(error)) throw error;
      await this.#commitFailure(row, this.#errorSummary(error));
      return;
    }

    try {
      await this.#commitDecision(row, definition, decision);
    } catch (error) {
      if (error instanceof MachineTransitionConflictError) return;
      if (isPlatformFailure(error)) throw error;
      await this.#commitFailure(row, this.#errorSummary(error));
    }
  }

  async #commitDecision(
    row: MachineRunRow,
    definition: RuntimeDefinition,
    decision: MachineDecision<MachinePhased, MachineValue>
  ): Promise<void> {
    if (!decision || typeof decision !== "object" || !("kind" in decision)) {
      throw new Error(
        `Machine phase for run "${row.run_id}" returned no decision`
      );
    }
    const participants = decision.commit ?? [];
    const nextRevision = row.revision + 1;
    const now = Date.now();

    this.#store.transaction(() => {
      for (const participant of participants) {
        applyMachineCommitParticipant(participant);
      }
      let written: number;
      if (decision.kind === "transition") {
        this.#assertState(row.definition, definition, decision.state);
        const checkpoint = serializeMachineValue(
          decision.state,
          `checkpoint for Machine run "${row.run_id}"`
        );
        this.#pushJob(row.run_id, nextRevision, now);
        written = this.#store.write(
          `UPDATE cf_agents_state_machine_runs
           SET phase = ?, checkpoint_json = ?, revision = ?, updated_at = ?
           WHERE run_id = ? AND status = 'running' AND revision = ?`,
          [
            decision.state.phase,
            checkpoint,
            nextRevision,
            now,
            row.run_id,
            row.revision
          ]
        );
      } else if (decision.kind === "complete") {
        const result = serializeMachineValue(
          decision.result,
          `result for Machine run "${row.run_id}"`
        );
        this.lifecycle.jobs.cancelSync(this.#jobId(row.run_id));
        written = this.#store.write(
          `UPDATE cf_agents_state_machine_runs
           SET status = 'completed', phase = NULL, checkpoint_json = NULL,
               result_json = ?, revision = ?, job_id = NULL,
               updated_at = ?, settled_at = ?
           WHERE run_id = ? AND status = 'running' AND revision = ?`,
          [result, nextRevision, now, now, row.run_id, row.revision]
        );
      } else {
        this.lifecycle.jobs.cancelSync(this.#jobId(row.run_id));
        written = this.#store.write(
          `UPDATE cf_agents_state_machine_runs
           SET status = 'failed', phase = NULL, checkpoint_json = NULL,
               error_name = ?, error_message = ?, revision = ?, job_id = NULL,
               updated_at = ?, settled_at = ?
           WHERE run_id = ? AND status = 'running' AND revision = ?`,
          [
            decision.error.name,
            decision.error.message,
            nextRevision,
            now,
            now,
            row.run_id,
            row.revision
          ]
        );
      }
      if (written !== 1) {
        throw new MachineTransitionConflictError(row.run_id, row.revision);
      }
      if (decision.kind !== "transition" && row.retain === 0) {
        this.#store.write(
          "DELETE FROM cf_agents_state_machine_runs WHERE run_id = ?",
          [row.run_id]
        );
      }
    });

    await this.lifecycle.jobs.rearm();
    for (const participant of participants) {
      try {
        publishMachineCommitParticipant(participant);
      } catch (error) {
        console.error("Machine commit participant publication failed", error);
      }
    }
    this.lifecycle.events.emit(`state-machine:${decision.kind}`, {
      runId: row.run_id,
      definition: row.definition,
      revision: nextRevision
    });
  }

  async #commitFailure(
    row: MachineRunRow,
    error: { name: string; message: string }
  ): Promise<void> {
    await this.#commitDecision(row, this.#definition(row.definition), {
      kind: "fail",
      error,
      commit: []
    });
  }

  #pushJob(runId: string, revision: number, time: number): void {
    this.lifecycle.jobs.pushSync({
      id: this.#jobId(runId),
      fn: "drive",
      time,
      payload: { runId, revision } satisfies DrivePayload,
      singleflight: true
    });
  }

  #context(row: MachineRunRow): MachineContext<MachinePhased, MachineValue> {
    const commit = (options?: MachineTransitionOptions) =>
      options?.commit ?? ([] as readonly MachineCommitParticipant[]);
    return Object.freeze({
      runId: row.run_id,
      revision: row.revision,
      transition: (
        state: MachinePhased,
        options?: MachineTransitionOptions
      ) => ({
        kind: "transition" as const,
        state,
        commit: commit(options)
      }),
      complete: (result: MachineValue, options?: MachineTransitionOptions) => ({
        kind: "complete" as const,
        result,
        commit: commit(options)
      }),
      fail: (error: unknown, options?: MachineTransitionOptions) => ({
        kind: "fail" as const,
        error: this.#errorSummary(error),
        commit: commit(options)
      })
    });
  }

  #definition(name: string): RuntimeDefinition {
    const definition = this.#definitions[name];
    if (!definition) throw new MissingMachineDefinitionError(name);
    return definition as unknown as RuntimeDefinition;
  }

  #assertState(
    definitionName: string,
    definition: RuntimeDefinition,
    state: MachinePhased
  ): void {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error(
        `Machine definition "${definitionName}" produced a non-object state`
      );
    }
    if (typeof state.phase !== "string" || state.phase.length === 0) {
      throw new Error(
        `Machine definition "${definitionName}" produced a state without a phase`
      );
    }
    if (!Object.hasOwn(definition.phases, state.phase)) {
      throw new Error(
        `Machine definition "${definitionName}" has no phase "${state.phase}"`
      );
    }
  }

  #jobId(runId: string): string {
    return `state-machine:${runId}`;
  }

  #errorSummary(error: unknown): { name: string; message: string } {
    return error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: "Error", message: String(error) };
  }
}
