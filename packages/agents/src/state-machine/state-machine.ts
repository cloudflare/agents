import { LifecycleCapability } from "../lifecycle/capability";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../lifecycle/job-queue";
import { isPlatformFailure } from "../retries";
import { applyMachineCommitParticipant } from "./commit";
import {
  MachineEventQueueFullError,
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
  MachineChildMode,
  MachineChildRef,
  MachineChildResult,
  MachineCommitParticipant,
  MachineCommitTransaction,
  MachineContext,
  MachineDecision,
  MachineDefinitions,
  MachineEffectOutcome,
  MachineEffectPlanOptions,
  MachineEffectRecovery,
  MachineEffectRef,
  MachineEffectRuntimes,
  MachineEvent,
  MachineEventFilter,
  MachineEventRow,
  MachineGateOptions,
  MachineGateOutcome,
  MachineGateRef,
  MachineInput,
  MachineJson,
  MachineOutput,
  MachinePhased,
  MachineQueuedEvent,
  MachineReceipt,
  MachineRunOptions,
  MachineRunRow,
  MachineRunSnapshot,
  MachineSendOptions,
  MachineSendReceipt,
  MachineSpawnOptions,
  MachineState,
  MachineTransitionOptions,
  MachineValue,
  MachineWaitOptions,
  MachineWake
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

type PendingGate = {
  id: string;
  kind: string;
  request: MachineValue;
  metadata: Record<string, MachineJson> | undefined;
  expiresAt: number;
};

type PendingEffect = {
  id: string;
  kind: string;
  input: MachineJson;
  recovery: MachineEffectRecovery;
  externalId: string | undefined;
};

type PendingChild = {
  runId: string;
  definition: string;
  definitionVersion: number;
  checkpoint: string | null;
  phase: string;
  mode: MachineChildMode;
};

type PendingChanges = {
  claimedEventIds: string[];
  gates: PendingGate[];
  effects: PendingEffect[];
  children: PendingChild[];
};

const MAX_EVENT_QUEUE_DEPTH = 1_000;
const MAX_OPEN_GATES = 100;
const MAX_ACTIVE_EFFECTS = 100;
const MAX_ACTIVE_CHILDREN = 100;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export interface StateMachineOptions<Definitions extends MachineDefinitions> {
  readonly definitions: Definitions;
  readonly effects?: MachineEffectRuntimes;
}

/** Durable checkpointed state machines driven by Lifecycle jobs. */
export class StateMachine<
  Definitions extends MachineDefinitions = MachineDefinitions
> extends LifecycleCapability {
  readonly #definitions: Definitions;
  readonly #effectRuntimes: MachineEffectRuntimes;
  readonly #effectControllers = new Map<string, AbortController>();
  #storeInstance: StateMachineStore | undefined;

  constructor(options: StateMachineOptions<Definitions>) {
    super("state-machine");
    this.#definitions = options.definitions;
    this.#effectRuntimes = options.effects ?? {};
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

  async send(
    runId: string,
    event: MachineEvent,
    options: MachineSendOptions
  ): Promise<MachineSendReceipt> {
    await this.lifecycle.ready();
    if (!options.eventId) throw new Error("Machine events require an eventId");
    if (!event.type) throw new Error("Machine events require a non-empty type");
    const eventJson = serializeMachineValue(event, "Machine event payload");
    if (eventJson === null)
      throw new Error("Machine events cannot be undefined");
    const expiresAt = this.#time(options.expiresAt);
    let wake = false;
    let receipt: MachineSendReceipt;

    this.#store.transaction(() => {
      const row = this.#store.getRun(runId);
      if (!row) {
        receipt = { status: "not-found" };
        return;
      }
      const existing = this.#store.getEvent(runId, options.eventId);
      if (existing) {
        if (existing.payload_json !== eventJson) {
          throw new Error(
            `Machine event "${options.eventId}" was reused with a different payload`
          );
        }
        receipt = { status: "duplicate", sequence: existing.sequence };
        return;
      }
      if (TERMINAL_STATUSES.has(row.status)) {
        receipt = { status: "terminal" };
        return;
      }
      const now = Date.now();
      // Retain consumed and expired event IDs for the life of the run so a
      // delayed duplicate can never feed a later wait. The total per-run cap
      // bounds both payload retention and the idempotency ledger.
      const queueDepth =
        this.#store.sql<{ count: number }>(
          `SELECT count(*) AS count FROM cf_agents_state_machine_events
           WHERE run_id = ?`,
          runId
        )[0]?.count ?? 0;
      if (queueDepth >= MAX_EVENT_QUEUE_DEPTH) {
        throw new MachineEventQueueFullError(runId);
      }
      const sequence = this.#store.nextEventSequence(runId);
      this.#store.sql(
        `INSERT INTO cf_agents_state_machine_events
          (run_id, sequence, event_id, type, event_key, payload_json,
           created_at, expires_at, consumed_revision, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        runId,
        sequence,
        options.eventId,
        event.type,
        typeof event.key === "string" ? event.key : null,
        eventJson,
        now,
        expiresAt ?? null
      );
      receipt = { status: "accepted", sequence };
      if (
        row.status === "waiting" &&
        row.wait_type === event.type &&
        (row.wait_key === null || row.wait_key === event.key) &&
        (row.next_at === null || now < row.next_at)
      ) {
        this.#store.write(
          `UPDATE cf_agents_state_machine_runs
           SET status = 'running', updated_at = ?
           WHERE run_id = ? AND status = 'waiting' AND revision = ?`,
          [now, runId, row.revision]
        );
        this.#pushJob(runId, row.revision, now);
        wake = true;
      }
    });
    if (wake) await this.lifecycle.jobs.rearm();
    if (receipt!.status === "accepted") {
      this.lifecycle.events.emit("state-machine:event:accepted", {
        runId,
        eventId: options.eventId,
        type: event.type
      });
    }
    return receipt!;
  }

  async answer<Payload extends MachineJson, Answer extends MachineJson>(
    gateId: string,
    kind: GateKind<Payload, Answer>,
    answer: Answer,
    options: { eventId: string }
  ): Promise<MachineAnswerReceipt> {
    await this.lifecycle.ready();
    const event: MachineEvent = {
      type: "state-machine:gate-answer",
      key: gateId,
      answer
    };
    const payload = serializeMachineValue(
      event,
      `answer for gate "${gateId}"`
    )!;
    let receipt: MachineAnswerReceipt;
    let wake = false;

    this.#store.transaction(() => {
      const gate = this.#store.getGate(gateId);
      if (!gate) {
        receipt = { status: "not-found" };
        return;
      }
      if (gate.kind !== kind.name) {
        receipt = { status: "wrong-kind" };
        return;
      }
      const existing = this.#store.getEvent(gate.run_id, options.eventId);
      if (existing) {
        if (existing.payload_json !== payload) {
          throw new Error(
            `Machine event "${options.eventId}" was reused with a different payload`
          );
        }
        receipt = { status: "duplicate" };
        return;
      }
      if (gate.state === "expired") {
        receipt = { status: "expired" };
        return;
      }
      if (gate.state !== "open") {
        receipt = { status: "terminal" };
        return;
      }
      const now = Date.now();
      if (now >= gate.expires_at) {
        this.#store.write(
          `UPDATE cf_agents_state_machine_gates
           SET state = 'expired', settled_at = ?
           WHERE gate_id = ? AND state = 'open'`,
          [now, gateId]
        );
        receipt = { status: "expired" };
        return;
      }
      const run = this.#store.getRun(gate.run_id);
      if (!run || TERMINAL_STATUSES.has(run.status)) {
        receipt = { status: run ? "terminal" : "not-found" };
        return;
      }
      this.#insertEventRow(run, options.eventId, event, now, undefined);
      this.#store.write(
        `UPDATE cf_agents_state_machine_gates
         SET state = 'answered', decision_event_id = ?, settled_at = ?
         WHERE gate_id = ? AND state = 'open'`,
        [options.eventId, now, gateId]
      );
      if (
        run.status === "waiting" &&
        run.wait_type === event.type &&
        (run.wait_key === null || run.wait_key === event.key) &&
        (run.next_at === null || now < run.next_at)
      ) {
        this.#store.write(
          `UPDATE cf_agents_state_machine_runs SET status = 'running', updated_at = ?
           WHERE run_id = ? AND revision = ?`,
          [now, run.run_id, run.revision]
        );
        this.#pushJob(run.run_id, run.revision, now);
        wake = true;
      }
      receipt = { status: "accepted" };
    });
    if (wake) await this.lifecycle.jobs.rearm();
    if (receipt!.status === "accepted") {
      this.lifecycle.events.emit("state-machine:gate:answered", {
        runId: gateId.split("#", 1)[0],
        gateId,
        kind: kind.name
      });
    }
    return receipt!;
  }

  async withdrawGate(gateId: string): Promise<boolean> {
    await this.lifecycle.ready();
    let withdrawn = false;
    let wake = false;
    this.#store.transaction(() => {
      const gate = this.#store.getGate(gateId);
      if (!gate || gate.state !== "open") return;
      const now = Date.now();
      withdrawn =
        this.#store.write(
          `UPDATE cf_agents_state_machine_gates
           SET state = 'withdrawn', settled_at = ?
           WHERE gate_id = ? AND state = 'open'`,
          [now, gateId]
        ) > 0;
      if (!withdrawn) return;
      const run = this.#store.getRun(gate.run_id);
      if (
        !run ||
        TERMINAL_STATUSES.has(run.status) ||
        run.status === "paused"
      ) {
        return;
      }
      this.#store.write(
        `UPDATE cf_agents_state_machine_runs SET status = 'running', updated_at = ?
         WHERE run_id = ? AND revision = ?`,
        [now, run.run_id, run.revision]
      );
      this.#pushJob(run.run_id, run.revision, now);
      wake = true;
    });
    if (wake) await this.lifecycle.jobs.rearm();
    if (withdrawn) {
      this.lifecycle.events.emit("state-machine:gate:withdrawn", { gateId });
    }
    return withdrawn;
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
      for (const child of this.#store.childrenForRun(runId)) {
        if (child.mode !== "attached" || child.status !== "running") continue;
        this.#store.write(
          `UPDATE cf_agents_state_machine_runs
           SET cancel_requested = 1, cancel_reason = ?, status = 'running',
               updated_at = ?
           WHERE run_id = ? AND status IN ('running', 'waiting', 'paused')`,
          [reason ?? "parent cancelled", now, child.child_run_id]
        );
        const childRow = this.#store.getRun(child.child_run_id);
        if (childRow) this.#pushJob(childRow.run_id, childRow.revision, now);
      }
      this.#pushJob(runId, row.revision, now);
      wake = true;
      receipt = { status: "requested" };
    });
    if (wake) {
      for (const [key, controller] of this.#effectControllers) {
        if (key.startsWith(`${runId}:`)) {
          controller.abort(new Error(reason ?? "cancelled"));
        }
      }
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
    const wake = this.#wake(row);
    const runtime = this.#context(row, wake);
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
        this.#applyPending(row, pending, nextRevision, now);
        this.#store.consumeEvents(
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
          this.#settleParentRelations(row, decision, nextRevision, now);
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
    for (const gate of pending.gates) {
      this.lifecycle.events.emit("state-machine:gate:opened", {
        runId: row.run_id,
        gateId: gate.id,
        kind: gate.kind,
        expiresAt: gate.expiresAt
      });
    }
    for (const effect of pending.effects) {
      this.lifecycle.events.emit("state-machine:effect:planned", {
        runId: row.run_id,
        effectId: effect.id,
        kind: effect.kind,
        recovery: effect.recovery
      });
    }
    for (const child of pending.children) {
      this.lifecycle.events.emit("state-machine:child:spawned", {
        runId: row.run_id,
        childRunId: child.runId,
        definition: child.definition,
        mode: child.mode
      });
    }
    await this.lifecycle.jobs.rearm();
    this.lifecycle.events.emit(`state-machine:${decision.kind}`, {
      runId: row.run_id,
      definition: row.definition,
      revision: nextRevision
    });
  }

  #context(
    row: MachineRunRow,
    wake: MachineWake
  ): {
    context: MachineContext<MachinePhased, MachineValue>;
    pending: PendingChanges;
  } {
    const pending: PendingChanges = {
      claimedEventIds: [],
      gates: [],
      effects: [],
      children: []
    };
    const takeEvent = (
      filter: MachineEventFilter
    ): MachineQueuedEvent | null => {
      const event = this.#store
        .matchingEvents(row.run_id, filter.type, filter.key, Date.now())
        .find(
          (candidate) => !pending.claimedEventIds.includes(candidate.event_id)
        );
      if (!event) return null;
      pending.claimedEventIds.push(event.event_id);
      return this.#eventFromRow(event);
    };
    const commit = (options?: MachineTransitionOptions) =>
      options?.commit ?? ([] as readonly MachineCommitParticipant[]);

    const context: MachineContext<MachinePhased, MachineValue> = Object.freeze({
      runId: row.run_id,
      revision: row.revision,
      wake,
      events: Object.freeze({
        take: <const Filter extends MachineEventFilter>(filter: Filter) =>
          takeEvent(filter) as MachineQueuedEvent<
            Extract<MachineEvent, { type: Filter["type"] }>
          > | null
      }),
      gates: Object.freeze({
        open: <Payload extends MachineJson, Answer extends MachineJson>(
          kind: GateKind<Payload, Answer>,
          request: Payload,
          options: MachineGateOptions
        ): MachineGateRef<Answer> => {
          const openGates = this.#store
            .gatesForRun(row.run_id)
            .filter((gate) => gate.state === "open").length;
          if (openGates + pending.gates.length >= MAX_OPEN_GATES) {
            throw new Error(
              `Machine run "${row.run_id}" has too many open gates`
            );
          }
          const id = `${row.run_id}#gate_${randomAlphanumeric()}`;
          pending.gates.push({
            id,
            kind: kind.name,
            request,
            metadata: options.metadata,
            expiresAt: this.#requiredTime(options.expiresAt)
          });
          return { id, kind: kind.name };
        },
        take: <Answer extends MachineJson>(
          gate: MachineGateRef<Answer>
        ): MachineGateOutcome<Answer> | null => {
          const queued = takeEvent({
            type: "state-machine:gate-answer",
            key: gate.id
          }) as MachineQueuedEvent<{
            type: "state-machine:gate-answer";
            key: string;
            answer: Answer;
          }> | null;
          if (queued) {
            return {
              status: "answered",
              answer: queued.event.answer,
              eventId: queued.eventId
            };
          }
          const stored = this.#store.getGate(gate.id);
          if (
            stored &&
            (stored.state === "expired" ||
              stored.state === "withdrawn" ||
              stored.state === "cancelled")
          ) {
            return { status: stored.state };
          }
          return null;
        }
      }),
      effects: Object.freeze({
        plan: <Input extends MachineJson, Output extends MachineValue>(
          kind: string,
          input: Input,
          options: MachineEffectPlanOptions
        ): MachineEffectRef<Output> => {
          const activeEffects = this.#store
            .effectsForRun(row.run_id)
            .filter(
              (effect) =>
                effect.status === "pending" || effect.status === "running"
            ).length;
          if (activeEffects + pending.effects.length >= MAX_ACTIVE_EFFECTS) {
            throw new Error(
              `Machine run "${row.run_id}" has too many active effects`
            );
          }
          const id = `effect_${randomAlphanumeric()}`;
          pending.effects.push({
            id,
            kind,
            input,
            recovery: options.recovery,
            externalId: options.externalId
          });
          return { id, kind, recovery: options.recovery };
        },
        execute: <Output extends MachineValue>(
          effect: MachineEffectRef<Output>
        ) => this.#executeEffect<Output>(row.run_id, effect)
      }),
      children: Object.freeze({
        spawn: <Output extends MachineValue = MachineValue>(
          definitionName: string,
          input: MachineValue,
          options: MachineSpawnOptions = {}
        ): MachineChildRef<Output> => {
          const activeChildren = this.#store
            .childrenForRun(row.run_id)
            .filter((child) => child.status === "running").length;
          if (activeChildren + pending.children.length >= MAX_ACTIVE_CHILDREN) {
            throw new Error(
              `Machine run "${row.run_id}" has too many active children`
            );
          }
          const definition = this.#definition(definitionName);
          const state = definition.initial(input);
          this.#assertState(definitionName, definition, state);
          const runId = options.runId ?? `machine_${randomAlphanumeric()}`;
          pending.children.push({
            runId,
            definition: definitionName,
            definitionVersion: definition.version,
            checkpoint: serializeMachineValue(
              state,
              `checkpoint for child Machine "${definitionName}"`
            ),
            phase: state.phase,
            mode: options.mode ?? "attached"
          });
          return {
            runId,
            definition: definitionName,
            mode: options.mode ?? "attached"
          };
        },
        take: <Output extends MachineValue>(child: MachineChildRef<Output>) => {
          const queued = takeEvent({
            type: "state-machine:child-completed",
            key: child.runId
          });
          if (!queued) return null;
          const event = queued.event as MachineEvent & {
            ok: boolean;
            output?: Output;
            error?: { name: string; message: string };
          };
          return event.ok
            ? ({
                ok: true,
                output: event.output as Output
              } satisfies MachineChildResult<Output>)
            : ({
                ok: false,
                error: event.error ?? {
                  name: "Error",
                  message: "Child Machine failed"
                }
              } satisfies MachineChildResult<Output>);
        }
      }),
      transition: (
        state: MachinePhased,
        options?: MachineTransitionOptions
      ) => ({
        kind: "transition" as const,
        state,
        commit: commit(options)
      }),
      wait: (
        state: MachinePhased,
        wait: MachineWaitOptions,
        options?: MachineTransitionOptions
      ) => ({ kind: "wait" as const, state, wait, commit: commit(options) }),
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
    return { context, pending };
  }

  #applyPending(
    row: MachineRunRow,
    pending: PendingChanges,
    nextRevision: number,
    now: number
  ): void {
    for (const gate of pending.gates) {
      this.#store.sql(
        `INSERT INTO cf_agents_state_machine_gates
          (gate_id, run_id, kind, request_json, metadata_json, state,
           expires_at, decision_event_id, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, ?, NULL)`,
        gate.id,
        row.run_id,
        gate.kind,
        serializeMachineValue(gate.request, `request for gate "${gate.id}"`) ??
          "null",
        serializeMachineValue(gate.metadata, `metadata for gate "${gate.id}"`),
        gate.expiresAt,
        now
      );
    }
    for (const effect of pending.effects) {
      this.#store.sql(
        `INSERT INTO cf_agents_state_machine_effects
          (run_id, effect_id, revision, kind, recovery, status, input_json,
           external_id, result_json, error_name, error_message, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, ?, NULL)`,
        row.run_id,
        effect.id,
        nextRevision,
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
    for (const child of pending.children) {
      this.#insertRun({
        runId: child.runId,
        definition: child.definition,
        definitionVersion: child.definitionVersion,
        phase: child.phase,
        checkpoint: child.checkpoint,
        retain: true,
        now
      });
      this.#store.sql(
        `INSERT INTO cf_agents_state_machine_children
          (parent_run_id, child_run_id, child_definition, mode, status,
           completion_event_id, created_at, settled_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, NULL)`,
        row.run_id,
        child.runId,
        child.definition,
        child.mode,
        `child_${child.runId}`,
        now
      );
      this.#pushJob(child.runId, 0, now);
    }
  }

  async #executeEffect<Output extends MachineValue>(
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

    const runtime = this.#effectRuntimes[row.kind];
    if (!runtime)
      throw new Error(`No runtime registered for Machine effect "${row.kind}"`);
    const wasRunning = row.status === "running";
    if (wasRunning && row.recovery === "never") {
      this.#markEffectInterrupted(runId, effect.id);
      return { status: "interrupted" };
    }
    if (wasRunning && row.recovery === "reconcile") {
      if (!row.external_id || !runtime.reconcile) {
        this.#markEffectInterrupted(runId, effect.id);
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
        this.#settleEffectCompleted(runId, effect.id, reconciled.output);
        return { status: "completed", output: reconciled.output as Output };
      }
      if (reconciled.status === "failed") {
        this.#settleEffectFailed(runId, effect.id, reconciled.error);
        return { status: "failed", error: reconciled.error };
      }
      this.#markEffectInterrupted(runId, effect.id);
      return { status: "interrupted" };
    }

    this.#store.write(
      `UPDATE cf_agents_state_machine_effects SET status = 'running'
       WHERE run_id = ? AND effect_id = ? AND status IN ('pending', 'running')`,
      [runId, effect.id]
    );
    row = this.#store.getEffect(runId, effect.id)!;
    this.lifecycle.events.emit("state-machine:effect:started", {
      runId,
      effectId: effect.id,
      kind: row.kind
    });
    const controller = new AbortController();
    const controllerKey = `${runId}:${effect.id}`;
    this.#effectControllers.set(controllerKey, controller);
    try {
      const output = await runtime.execute(JSON.parse(row.input_json), {
        effectId: row.effect_id,
        idempotencyKey: `${runId}:${row.effect_id}`,
        ...(row.external_id ? { externalId: row.external_id } : {}),
        signal: controller.signal
      });
      this.#settleEffectCompleted(runId, effect.id, output);
      return { status: "completed", output: output as Output };
    } catch (error) {
      const summary = this.#errorSummary(error);
      this.#settleEffectFailed(runId, effect.id, summary);
      return { status: "failed", error: summary };
    } finally {
      this.#effectControllers.delete(controllerKey);
    }
  }

  #settleEffectCompleted(
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
    this.lifecycle.events.emit("state-machine:effect:completed", {
      runId,
      effectId
    });
  }

  #settleEffectFailed(
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
    this.lifecycle.events.emit("state-machine:effect:failed", {
      runId,
      effectId,
      error: error.name
    });
  }

  #markEffectInterrupted(runId: string, effectId: string): void {
    this.#store.write(
      `UPDATE cf_agents_state_machine_effects
       SET status = 'interrupted', settled_at = ?
       WHERE run_id = ? AND effect_id = ? AND status = 'running'`,
      [Date.now(), runId, effectId]
    );
  }

  #settleParentRelations(
    row: MachineRunRow,
    decision: Extract<
      MachineDecision<MachinePhased, MachineValue>,
      { kind: "complete" | "fail" }
    >,
    _revision: number,
    now: number
  ): void {
    for (const relation of this.#store.parentRelations(row.run_id)) {
      this.#store.write(
        `UPDATE cf_agents_state_machine_children
         SET status = ?, settled_at = ?
         WHERE parent_run_id = ? AND child_run_id = ? AND status = 'running'`,
        [
          decision.kind === "complete" ? "completed" : "failed",
          now,
          relation.parent_run_id,
          row.run_id
        ]
      );
      const parent = this.#store.getRun(relation.parent_run_id);
      if (!parent || TERMINAL_STATUSES.has(parent.status)) continue;
      const event: MachineEvent =
        decision.kind === "complete"
          ? {
              type: "state-machine:child-completed",
              key: row.run_id,
              childRunId: row.run_id,
              ok: true,
              output: decision.result as MachineJson | undefined
            }
          : {
              type: "state-machine:child-completed",
              key: row.run_id,
              childRunId: row.run_id,
              ok: false,
              error: decision.error
            };
      this.#insertEventRow(
        parent,
        relation.completion_event_id,
        event,
        now,
        undefined
      );
      if (
        parent.status === "waiting" &&
        parent.wait_type === event.type &&
        (parent.wait_key === null || parent.wait_key === event.key)
      ) {
        this.#store.write(
          `UPDATE cf_agents_state_machine_runs SET status = 'running', updated_at = ?
           WHERE run_id = ? AND revision = ?`,
          [now, parent.run_id, parent.revision]
        );
        this.#pushJob(parent.run_id, parent.revision, now);
      }
    }
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
      for (const relation of this.#store.parentRelations(row.run_id)) {
        const relationSettled = this.#store.write(
          `UPDATE cf_agents_state_machine_children
           SET status = 'cancelled', settled_at = ?
           WHERE parent_run_id = ? AND child_run_id = ? AND status = 'running'`,
          [now, relation.parent_run_id, row.run_id]
        );
        if (relationSettled === 0) continue;
        const parent = this.#store.getRun(relation.parent_run_id);
        if (!parent || TERMINAL_STATUSES.has(parent.status)) continue;
        const event: MachineEvent = {
          type: "state-machine:child-completed",
          key: row.run_id,
          childRunId: row.run_id,
          ok: false,
          error: { name: "Cancelled", message: reason ?? "Child cancelled" }
        };
        this.#insertEventRow(
          parent,
          relation.completion_event_id,
          event,
          now,
          undefined
        );
        if (
          parent.status === "waiting" &&
          parent.wait_type === event.type &&
          (parent.wait_key === null || parent.wait_key === event.key)
        ) {
          this.#store.write(
            `UPDATE cf_agents_state_machine_runs SET status = 'running', updated_at = ?
             WHERE run_id = ? AND revision = ?`,
            [now, parent.run_id, parent.revision]
          );
          this.#pushJob(parent.run_id, parent.revision, now);
        }
      }
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

  #insertEventRow(
    row: MachineRunRow,
    eventId: string,
    event: MachineEvent,
    now: number,
    expiresAt: number | undefined
  ): number {
    const sequence = this.#store.nextEventSequence(row.run_id);
    const payload = serializeMachineValue(event, `Machine event "${eventId}"`);
    if (payload === null) throw new Error("Machine events cannot be undefined");
    this.#store.sql(
      `INSERT INTO cf_agents_state_machine_events
        (run_id, sequence, event_id, type, event_key, payload_json,
         created_at, expires_at, consumed_revision, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      row.run_id,
      sequence,
      eventId,
      event.type,
      typeof event.key === "string" ? event.key : null,
      payload,
      now,
      expiresAt ?? null
    );
    return sequence;
  }

  #eventFromRow(row: MachineEventRow): MachineQueuedEvent {
    return {
      eventId: row.event_id,
      sequence: row.sequence,
      event: JSON.parse(row.payload_json),
      createdAt: row.created_at,
      ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {})
    };
  }

  #wake(row: MachineRunRow): MachineWake {
    if (row.cancel_requested === 1) {
      return {
        kind: "cancel",
        ...(row.cancel_reason ? { reason: row.cancel_reason } : {})
      };
    }
    if (row.wait_type && row.next_at !== null && Date.now() >= row.next_at) {
      return {
        kind: "timeout",
        type: row.wait_type,
        ...(row.wait_key ? { key: row.wait_key } : {})
      };
    }
    if (row.wait_type) {
      return {
        kind: "event",
        type: row.wait_type,
        ...(row.wait_key ? { key: row.wait_key } : {})
      };
    }
    return { kind: "ordinary" };
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

  #requiredTime(value: number | Date): number {
    return this.#time(value)!;
  }

  #errorSummary(error: unknown): { name: string; message: string } {
    return error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: "Error", message: String(error) };
  }
}
