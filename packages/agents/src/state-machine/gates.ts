import type { LifecycleJobs } from "../lifecycle/job-queue";
import { machineBuilderId } from "./ids";
import { serializeMachineValue } from "./serialization";
import type { StateMachineStore } from "./store";
import { TERMINAL_STATUSES, type MachineEventManager } from "./events";
import type {
  GateKind,
  MachineAnswerReceipt,
  MachineGateOptions,
  MachineGateOutcome,
  MachineGateRef,
  MachineJson,
  MachineQueuedEvent,
  MachineRunRow,
  MachineValue
} from "./types";

const MAX_OPEN_GATES = 100;

export type PendingGate = {
  id: string;
  kind: string;
  request: MachineValue;
  metadata: Record<string, MachineJson> | undefined;
  expiresAt: number;
};

export type MachineGateManagerOptions = {
  readonly store: StateMachineStore;
  readonly events: MachineEventManager;
  readonly jobs: LifecycleJobs;
  readonly emit: (type: string, payload: unknown) => void;
};

export class MachineGateManager {
  readonly #store: StateMachineStore;
  readonly #events: MachineEventManager;
  readonly #jobs: LifecycleJobs;
  readonly #emit: (type: string, payload: unknown) => void;

  constructor(options: MachineGateManagerOptions) {
    this.#store = options.store;
    this.#events = options.events;
    this.#jobs = options.jobs;
    this.#emit = options.emit;
  }

  create<Payload extends MachineJson, Answer extends MachineJson>(
    row: MachineRunRow,
    pending: PendingGate[],
    ordinal: number,
    kind: GateKind<Payload, Answer>,
    request: Payload,
    options: MachineGateOptions
  ): MachineGateRef<Answer> {
    const id = machineBuilderId(
      row.run_id,
      row.builder_revision,
      "gate",
      ordinal
    );
    const expiresAt = requiredTime(options.expiresAt);
    const requestJson =
      serializeMachineValue(request, `request for gate "${id}"`) ?? "null";
    const metadataJson = serializeMachineValue(
      options.metadata,
      `metadata for gate "${id}"`
    );
    const existing = this.#store.getGate(id);
    if (existing) {
      if (
        existing.run_id !== row.run_id ||
        existing.kind !== kind.name ||
        existing.request_json !== requestJson ||
        existing.metadata_json !== metadataJson ||
        existing.expires_at !== expiresAt
      ) {
        throw new Error(
          `Machine gate "${id}" was replayed with a different definition`
        );
      }
      return { id, kind: kind.name };
    }
    const openGates = this.#store
      .gatesForRun(row.run_id)
      .filter((gate) => gate.state === "open").length;
    if (openGates + pending.length >= MAX_OPEN_GATES) {
      throw new Error(`Machine run "${row.run_id}" has too many open gates`);
    }
    pending.push({
      id,
      kind: kind.name,
      request,
      metadata: options.metadata,
      expiresAt
    });
    return { id, kind: kind.name };
  }

  take<Answer extends MachineJson>(
    gate: MachineGateRef<Answer>,
    takeEvent: (type: string, key: string) => MachineQueuedEvent | null
  ): MachineGateOutcome<Answer> | null {
    const queued = takeEvent(
      "state-machine:gate-answer",
      gate.id
    ) as MachineQueuedEvent<{
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

  applyPending(
    runId: string,
    pending: readonly PendingGate[],
    now: number
  ): void {
    for (const gate of pending) {
      this.#store.sql(
        `INSERT INTO cf_agents_state_machine_gates
          (gate_id, run_id, kind, request_json, metadata_json, state,
           expires_at, decision_event_id, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, ?, NULL)`,
        gate.id,
        runId,
        gate.kind,
        serializeMachineValue(gate.request, `request for gate "${gate.id}"`) ??
          "null",
        serializeMachineValue(gate.metadata, `metadata for gate "${gate.id}"`),
        gate.expiresAt,
        now
      );
    }
  }

  publishPending(runId: string, pending: readonly PendingGate[]): void {
    for (const gate of pending) {
      this.#emit("state-machine:gate:opened", {
        runId,
        gateId: gate.id,
        kind: gate.kind,
        expiresAt: gate.expiresAt
      });
    }
  }

  async notify<Payload extends MachineJson, Answer extends MachineJson>(
    gateId: string,
    kind: GateKind<Payload, Answer>,
    answer: Answer,
    options: { eventId: string }
  ): Promise<MachineAnswerReceipt> {
    const event = {
      type: "state-machine:gate-answer",
      key: gateId,
      answer
    } as const;
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
      this.#events.insert(run, options.eventId, event, now, undefined);
      this.#store.write(
        `UPDATE cf_agents_state_machine_gates
         SET state = 'answered', decision_event_id = ?, settled_at = ?
         WHERE gate_id = ? AND state = 'open'`,
        [options.eventId, now, gateId]
      );
      wake = this.#events.wakeWaitingRun(run, event, now);
      receipt = { status: "accepted" };
    });
    if (wake) await this.#jobs.rearm();
    if (receipt!.status === "accepted") {
      this.#emit("state-machine:gate:answered", {
        runId: gateId.split("#", 1)[0],
        gateId,
        kind: kind.name
      });
    }
    return receipt!;
  }

  async withdraw(gateId: string): Promise<boolean> {
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
      this.#events.wakeWaitingRun(
        {
          ...run,
          status: "waiting",
          wait_type: "state-machine:gate-answer",
          wait_key: gateId
        },
        { type: "state-machine:gate-answer", key: gateId },
        now
      );
      wake = true;
    });
    if (wake) await this.#jobs.rearm();
    if (withdrawn) this.#emit("state-machine:gate:withdrawn", { gateId });
    return withdrawn;
  }
}

function requiredTime(value: number | Date): number {
  const time = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(time) || time < 0)
    throw new Error("Invalid Machine time");
  return Math.floor(time);
}
