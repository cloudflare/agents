import { LifecycleCapability } from "../lifecycle/capability";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../lifecycle/job-queue";
import { isPlatformFailure } from "../retries";
import { MachineChildManager } from "./children";
import { applyMachineCommitParticipant } from "./commit";
import { createMachineContext, type PendingChanges } from "./context";
import { MachineEffectManager } from "./effects";
import { MachineEventManager, TERMINAL_STATUSES } from "./events";
import { MachineGateManager } from "./gates";
import {
  MachineTransitionConflictError,
  MissingMachineDefinitionError
} from "./errors";
import { randomAlphanumeric } from "./ids";
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
  GateKind,
  MachineAnswerReceipt,
  MachineCancelReceipt,
  MachineCommitTransaction,
  MachineContext,
  MachineDecision,
  MachineDefinitions,
  MachineEffectRuntimes,
  MachineEvent,
  MachineInput,
  MachineJson,
  MachineOutput,
  MachinePhased,
  MachineReceipt,
  MachineRunOptions,
  MachineRunRow,
  MachineRunSnapshot,
  MachineNotifyOptions,
  MachineNotifyReceipt,
  MachineState,
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
  onCancel?: (
    state: MachinePhased,
    context: MachineContext<MachinePhased, MachineValue>
  ) =>
    | MachineDecision<MachinePhased, MachineValue>
    | Promise<MachineDecision<MachinePhased, MachineValue>>;
};

type DrivePayload = { runId: string; revision: number };

export interface StateMachineOptions<Definitions extends MachineDefinitions> {
  readonly definitions: Definitions;
  readonly effects?: MachineEffectRuntimes;
}

export interface StateMachineGateNotifications {
  notify<Payload extends MachineJson, Answer extends MachineJson>(
    gateId: string,
    kind: GateKind<Payload, Answer>,
    answer: Answer,
    options: { eventId: string }
  ): Promise<MachineAnswerReceipt>;
  withdraw(gateId: string): Promise<boolean>;
}

/** Durable checkpointed state machines driven by Lifecycle jobs. */
export class StateMachine<
  Definitions extends MachineDefinitions = MachineDefinitions
> extends LifecycleCapability {
  readonly #definitions: Definitions;
  readonly #effectRuntimes: MachineEffectRuntimes;
  #storeInstance: StateMachineStore | undefined;
  #eventManager: MachineEventManager | undefined;
  #gateManager: MachineGateManager | undefined;
  #effectManager: MachineEffectManager | undefined;
  #childManager: MachineChildManager | undefined;
  readonly gates: StateMachineGateNotifications;

  constructor(options: StateMachineOptions<Definitions>) {
    super("state-machine");
    this.#definitions = options.definitions;
    this.#effectRuntimes = options.effects ?? {};
    this.gates = Object.freeze({
      notify: async <Payload extends MachineJson, Answer extends MachineJson>(
        gateId: string,
        kind: GateKind<Payload, Answer>,
        answer: Answer,
        notifyOptions: { eventId: string }
      ) => {
        await this.lifecycle.ready();
        return this.#gates.notify(gateId, kind, answer, notifyOptions);
      },
      withdraw: async (gateId: string) => {
        await this.lifecycle.ready();
        return this.#gates.withdraw(gateId);
      }
    });
  }

  get #store(): StateMachineStore {
    this.#storeInstance ??= new StateMachineStore(this.lifecycle.storage);
    return this.#storeInstance;
  }

  get #events(): MachineEventManager {
    this.#eventManager ??= new MachineEventManager({
      store: this.#store,
      jobs: this.lifecycle.jobs,
      pushJob: (runId, revision, time) => this.#pushJob(runId, revision, time),
      emit: (type, payload) => this.lifecycle.events.emit(type, payload)
    });
    return this.#eventManager;
  }

  get #gates(): MachineGateManager {
    this.#gateManager ??= new MachineGateManager({
      store: this.#store,
      events: this.#events,
      jobs: this.lifecycle.jobs,
      emit: (type, payload) => this.lifecycle.events.emit(type, payload)
    });
    return this.#gateManager;
  }

  get #effects(): MachineEffectManager {
    this.#effectManager ??= new MachineEffectManager({
      store: this.#store,
      runtimes: this.#effectRuntimes,
      emit: (type, payload) => this.lifecycle.events.emit(type, payload)
    });
    return this.#effectManager;
  }

  get #children(): MachineChildManager {
    this.#childManager ??= new MachineChildManager({
      store: this.#store,
      events: this.#events,
      definition: (name) => this.#definition(name),
      assertState: (name, definition, state) =>
        this.#assertState(name, definition as RuntimeDefinition, state),
      insertRun: (input) => this.#insertRun(input),
      pushJob: (runId, revision, time) => this.#pushJob(runId, revision, time),
      emit: (type, payload) => this.lifecycle.events.emit(type, payload)
    });
    return this.#childManager;
  }

  async onStart(): Promise<void> {
    const version =
      (await this.lifecycle.storage.get<number>(
        STATE_MACHINE_SCHEMA_VERSION_KEY
      )) ?? 0;
    if (version < STATE_MACHINE_SCHEMA_VERSION) {
      migrateStateMachineSchema(this.#store, version);
      await this.lifecycle.storage.put(
        STATE_MACHINE_SCHEMA_VERSION_KEY,
        STATE_MACHINE_SCHEMA_VERSION
      );
    }

    this.#store.transaction(() => {
      const now = Date.now();
      for (const row of this.#store.listOpen()) {
        if (row.status === "running") {
          this.#pushJob(row.run_id, row.revision, now);
        } else if (row.next_at !== null) {
          this.#pushJob(row.run_id, row.revision, row.next_at);
        } else {
          this.lifecycle.jobs.cancelSync(this.#jobId(row.run_id));
        }
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
    this.#validateRunOptions(options);

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
    const runId = options.runId ?? `machine_${randomAlphanumeric()}`;
    const now = Date.now();

    this.#store.transaction(() => {
      this.#insertRun({
        runId,
        definition: definitionName,
        definitionVersion: definition.version,
        phase: initial.phase,
        checkpoint,
        retain: options.retain !== false,
        idempotencyKey: options.idempotencyKey,
        now
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

  async notify(
    runId: string,
    event: MachineEvent,
    options: MachineNotifyOptions
  ): Promise<MachineNotifyReceipt> {
    await this.lifecycle.ready();
    return this.#events.notify(runId, event, options);
  }

  async cancel(runId: string, reason?: string): Promise<MachineCancelReceipt> {
    await this.lifecycle.ready();
    let receipt: MachineCancelReceipt;
    let wake = false;
    this.#store.transaction(() => {
      const row = this.#store.getRun(runId);
      if (!row) {
        receipt = { status: "not-found" };
        return;
      }
      if (TERMINAL_STATUSES.has(row.status)) {
        receipt = { status: "terminal" };
        return;
      }
      const now = Date.now();
      this.#store.write(
        `UPDATE cf_agents_state_machine_runs
         SET cancel_requested = 1, cancel_reason = ?, status = 'running',
             updated_at = ? WHERE run_id = ?`,
        [reason ?? null, now, runId]
      );
      this.#children.cascadeAttachedCancellation(runId, reason, now);
      this.#pushJob(runId, row.revision, now);
      wake = true;
      receipt = { status: "requested" };
    });
    if (wake) {
      this.#effects.abortLive(runId, reason);
      await this.lifecycle.jobs.rearm();
    }
    if (receipt!.status === "requested") {
      this.lifecycle.events.emit("state-machine:cancel:requested", {
        runId,
        reason: reason ?? null
      });
    }
    return receipt!;
  }

  async terminate(runId: string, reason?: string): Promise<boolean> {
    await this.lifecycle.ready();
    const row = this.#store.getRun(runId);
    if (!row || TERMINAL_STATUSES.has(row.status)) return false;
    await this.#commitCancelled(row, reason);
    return true;
  }

  async delete(runId: string): Promise<boolean> {
    await this.lifecycle.ready();
    let deleted = false;
    this.#store.transaction(() => {
      const row = this.#store.getRun(runId);
      if (!row || !TERMINAL_STATUSES.has(row.status)) return;
      this.lifecycle.jobs.cancelSync(this.#jobId(runId));
      this.#store.deleteOwnedRows(runId);
      this.#store.write(
        `DELETE FROM cf_agents_state_machine_children
         WHERE child_run_id = ?`,
        [runId]
      );
      deleted =
        this.#store.write(
          "DELETE FROM cf_agents_state_machine_runs WHERE run_id = ?",
          [runId]
        ) > 0;
    });
    if (deleted) await this.lifecycle.jobs.rearm();
    return deleted;
  }

  async pause(runId: string): Promise<boolean> {
    await this.lifecycle.ready();
    let paused = false;
    this.#store.transaction(() => {
      const row = this.#store.getRun(runId);
      if (!row || (row.status !== "running" && row.status !== "waiting"))
        return;
      paused =
        this.#store.write(
          `UPDATE cf_agents_state_machine_runs SET status = 'paused', updated_at = ?
           WHERE run_id = ? AND revision = ?`,
          [Date.now(), runId, row.revision]
        ) === 1;
      if (paused) this.lifecycle.jobs.cancelSync(this.#jobId(runId));
    });
    if (paused) await this.lifecycle.jobs.rearm();
    return paused;
  }

  async resume(runId: string): Promise<boolean> {
    await this.lifecycle.ready();
    let resumed = false;
    this.#store.transaction(() => {
      const row = this.#store.getRun(runId);
      if (!row || row.status !== "paused") return;
      const now = Date.now();
      resumed =
        this.#store.write(
          `UPDATE cf_agents_state_machine_runs
           SET status = 'running', updated_at = ? WHERE run_id = ? AND revision = ?`,
          [now, runId, row.revision]
        ) === 1;
      if (resumed) this.#pushJob(runId, row.revision, now);
    });
    if (resumed) await this.lifecycle.jobs.rearm();
    return resumed;
  }

  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (context.job.fn !== "drive") {
      throw new Error(`Unknown StateMachine job function "${context.job.fn}"`);
    }
    const payload = context.job.payload as DrivePayload;
    if (!payload || typeof payload.runId !== "string") {
      throw new Error("Invalid StateMachine drive payload");
    }
    const row = this.#store.getRun(payload.runId);
    if (
      row?.status === "waiting" &&
      row.next_at !== null &&
      Date.now() < row.next_at
    ) {
      return { rescheduleAt: row.next_at };
    }
    await this.#drive(payload);
    return undefined;
  }

  async #drive(input: DrivePayload): Promise<void> {
    const row = this.#store.getRun(input.runId);
    if (
      !row ||
      row.status === "paused" ||
      TERMINAL_STATUSES.has(row.status) ||
      row.revision !== input.revision
    ) {
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
    const wake = this.#events.wake(row);
    const runtime = createMachineContext({
      row,
      wake,
      events: this.#events,
      gates: this.#gates,
      effects: this.#effects,
      children: this.#children,
      errorSummary: (error) => this.#errorSummary(error)
    });
    if (row.cancel_requested === 1 && !definition.onCancel) {
      await this.#commitCancelled(row, row.cancel_reason ?? undefined);
      return;
    }
    const handler =
      row.cancel_requested === 1
        ? definition.onCancel
        : definition.phases[state.phase];
    if (!handler) throw new MissingMachineDefinitionError(row.definition);

    let decision: MachineDecision<MachinePhased, MachineValue>;
    try {
      decision = (await this.lifecycle.runInHostContext(() =>
        handler(state, runtime.context)
      )) as MachineDecision<MachinePhased, MachineValue>;
    } catch (error) {
      if (isPlatformFailure(error)) throw error;
      await this.#commitFailure(row, this.#errorSummary(error));
      return;
    }

    const latest = this.#store.getRun(row.run_id);
    if (row.cancel_requested === 0 && latest?.cancel_requested === 1) {
      // The already-admitted phase may settle its external evidence, but a
      // concurrent durable cancellation owns the next machine transition.
      return;
    }

    try {
      await this.#commitDecision(
        row,
        definition,
        decision,
        runtime.pending,
        row.cancel_requested === 1
      );
    } catch (error) {
      if (error instanceof MachineTransitionConflictError) return;
      if (isPlatformFailure(error)) throw error;
      await this.#commitFailure(row, this.#errorSummary(error));
    }
  }

  async #commitDecision(
    row: MachineRunRow,
    definition: RuntimeDefinition,
    decision: MachineDecision<MachinePhased, MachineValue>,
    pending: PendingChanges,
    handlingCancel = false
  ): Promise<void> {
    if (!decision || typeof decision !== "object" || !("kind" in decision)) {
      throw new Error(
        `Machine phase for run "${row.run_id}" returned no decision`
      );
    }
    if (decision.kind === "wait" && pending.claimedEventIds.length > 0) {
      throw new Error("A Machine phase cannot claim an event and then wait");
    }
    const participants = decision.commit ?? [];
    const nextRevision = row.revision + 1;
    const now = Date.now();
    const afterCommitCallbacks: Array<() => void> = [];
    let transactionOpen = true;
    const commitTransaction: MachineCommitTransaction = Object.freeze({
      afterCommit: (callback: () => void) => {
        if (!transactionOpen) {
          throw new Error("Machine commit transaction is no longer active");
        }
        afterCommitCallbacks.push(callback);
      }
    });

    try {
      this.#store.transaction(() => {
        for (const participant of participants) {
          applyMachineCommitParticipant(participant, commitTransaction);
        }
        this.#gates.applyPending(row.run_id, pending.gates, now);
        this.#effects.applyPending(
          row.run_id,
          nextRevision,
          pending.effects,
          now
        );
        this.#children.applyPending(row.run_id, pending.children, now);
        this.#events.consume(
          row.run_id,
          pending.claimedEventIds,
          nextRevision,
          now
        );

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
             SET status = 'running', phase = ?, checkpoint_json = ?, revision = ?,
                 wait_kind = NULL, wait_type = NULL, wait_key = NULL,
                 next_at = NULL, cancel_requested = ?, cancel_reason = NULL,
                 updated_at = ?
             WHERE run_id = ? AND status IN ('running', 'waiting') AND revision = ?`,
            [
              decision.state.phase,
              checkpoint,
              nextRevision,
              handlingCancel ? 0 : row.cancel_requested,
              now,
              row.run_id,
              row.revision
            ]
          );
        } else if (decision.kind === "wait") {
          this.#assertState(row.definition, definition, decision.state);
          const checkpoint = serializeMachineValue(
            decision.state,
            `checkpoint for Machine run "${row.run_id}"`
          );
          const timeoutAt = this.#time(decision.wait.timeoutAt);
          const matching = this.#store.matchingEvents(
            row.run_id,
            decision.wait.type,
            decision.wait.key,
            now
          )[0];
          const shouldDrive = matching !== undefined;
          if (shouldDrive) {
            this.#pushJob(row.run_id, nextRevision, now);
          } else if (timeoutAt !== undefined) {
            this.#pushJob(row.run_id, nextRevision, timeoutAt);
          } else {
            this.lifecycle.jobs.cancelSync(this.#jobId(row.run_id));
          }
          written = this.#store.write(
            `UPDATE cf_agents_state_machine_runs
             SET status = ?, phase = ?, checkpoint_json = ?, revision = ?,
                 wait_kind = 'event', wait_type = ?, wait_key = ?, next_at = ?,
                 cancel_requested = ?, cancel_reason = NULL, updated_at = ?
             WHERE run_id = ? AND status IN ('running', 'waiting') AND revision = ?`,
            [
              shouldDrive ? "running" : "waiting",
              decision.state.phase,
              checkpoint,
              nextRevision,
              decision.wait.type,
              decision.wait.key ?? null,
              timeoutAt ?? null,
              handlingCancel ? 0 : row.cancel_requested,
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
                 wait_kind = NULL, wait_type = NULL, wait_key = NULL, next_at = NULL,
                 updated_at = ?, settled_at = ?
             WHERE run_id = ? AND status IN ('running', 'waiting') AND revision = ?`,
            [result, nextRevision, now, now, row.run_id, row.revision]
          );
        } else {
          this.lifecycle.jobs.cancelSync(this.#jobId(row.run_id));
          written = this.#store.write(
            `UPDATE cf_agents_state_machine_runs
             SET status = 'failed', phase = NULL, checkpoint_json = NULL,
                 error_name = ?, error_message = ?, revision = ?, job_id = NULL,
                 wait_kind = NULL, wait_type = NULL, wait_key = NULL, next_at = NULL,
                 updated_at = ?, settled_at = ?
             WHERE run_id = ? AND status IN ('running', 'waiting') AND revision = ?`,
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
        if (decision.kind === "complete" || decision.kind === "fail") {
          this.#store.write(
            `UPDATE cf_agents_state_machine_gates
             SET state = CASE WHEN expires_at <= ? THEN 'expired' ELSE 'cancelled' END,
                 settled_at = ?
             WHERE run_id = ? AND state = 'open'`,
            [now, now, row.run_id]
          );
          this.#children.settleParentRelations(row, decision, now);
          if (row.retain === 0) {
            this.#store.deleteOwnedRows(row.run_id);
            this.#store.write(
              "DELETE FROM cf_agents_state_machine_runs WHERE run_id = ?",
              [row.run_id]
            );
          }
        }
      });
    } finally {
      transactionOpen = false;
    }

    for (const callback of afterCommitCallbacks) {
      try {
        callback();
      } catch (error) {
        console.error("Machine afterCommit callback failed", error);
      }
    }
    this.#gates.publishPending(row.run_id, pending.gates);
    this.#effects.publishPending(row.run_id, pending.effects);
    this.#children.publishPending(row.run_id, pending.children);
    await this.lifecycle.jobs.rearm();
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
    await this.#commitDecision(
      row,
      this.#definition(row.definition),
      { kind: "fail", error, commit: [] },
      { claimedEventIds: [], gates: [], effects: [], children: [] }
    );
  }

  async #commitCancelled(row: MachineRunRow, reason?: string): Promise<void> {
    const now = Date.now();
    this.#store.transaction(() => {
      this.lifecycle.jobs.cancelSync(this.#jobId(row.run_id));
      const written = this.#store.write(
        `UPDATE cf_agents_state_machine_runs
         SET status = 'cancelled', phase = NULL, checkpoint_json = NULL,
             error_name = 'Cancelled', error_message = ?, revision = revision + 1,
             job_id = NULL, wait_kind = NULL, wait_type = NULL, wait_key = NULL,
             next_at = NULL, updated_at = ?, settled_at = ?
         WHERE run_id = ? AND status IN ('running', 'waiting', 'paused')`,
        [reason ?? "Machine run cancelled", now, now, row.run_id]
      );
      if (written !== 1)
        throw new MachineTransitionConflictError(row.run_id, row.revision);
      this.#store.write(
        `UPDATE cf_agents_state_machine_gates
         SET state = 'cancelled', settled_at = ? WHERE run_id = ? AND state = 'open'`,
        [now, row.run_id]
      );
      this.#children.settleCancelledRelations(row, reason, now);
    });
    await this.lifecycle.jobs.rearm();
  }

  #insertRun(input: {
    runId: string;
    definition: string;
    definitionVersion: number;
    phase: string;
    checkpoint: string | null;
    retain: boolean;
    idempotencyKey?: string;
    now: number;
  }): void {
    this.#store.insertRun({
      run_id: input.runId,
      definition: input.definition,
      definition_version: input.definitionVersion,
      status: "running",
      phase: input.phase,
      checkpoint_json: input.checkpoint,
      revision: 0,
      control_json: '{"status":"running"}',
      job_id: this.#jobId(input.runId),
      wait_kind: null,
      wait_type: null,
      wait_key: null,
      next_at: null,
      event_sequence: 0,
      cancel_requested: 0,
      cancel_reason: null,
      result_json: null,
      error_name: null,
      error_message: null,
      retain: input.retain ? 1 : 0,
      idempotency_key: input.idempotencyKey ?? null,
      created_at: input.now,
      updated_at: input.now,
      settled_at: null
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

  #pushJob(runId: string, revision: number, time: number): void {
    this.lifecycle.jobs.pushSync({
      id: this.#jobId(runId),
      fn: "drive",
      time,
      payload: { runId, revision } satisfies DrivePayload,
      singleflight: true
    });
  }

  #jobId(runId: string): string {
    return `state-machine:${runId}`;
  }

  #validateRunOptions(options: MachineRunOptions): void {
    if (options.runId !== undefined && options.runId.length === 0) {
      throw new Error("Machine runId must be a non-empty string");
    }
    if (
      options.idempotencyKey !== undefined &&
      options.idempotencyKey.length === 0
    ) {
      throw new Error("Machine idempotencyKey must be a non-empty string");
    }
  }

  #time(value: number | Date | undefined): number | undefined {
    if (value === undefined) return undefined;
    const time = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(time) || time < 0)
      throw new Error("Invalid Machine time");
    return Math.floor(time);
  }

  #errorSummary(error: unknown): { name: string; message: string } {
    return error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: "Error", message: String(error) };
  }
}
