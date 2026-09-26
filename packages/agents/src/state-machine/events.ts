import type { LifecycleJobs } from "../lifecycle/job-queue";
import { MachineEventQueueFullError } from "./errors";
import { serializeMachineValue } from "./serialization";
import type { StateMachineStore } from "./store";
import type {
  MachineEvent,
  MachineEventFilter,
  MachineEventRow,
  MachineQueuedEvent,
  MachineRunRow,
  MachineNotifyOptions,
  MachineNotifyReceipt,
  MachineWake
} from "./types";

const MAX_EVENT_QUEUE_DEPTH = 1_000;
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export type MachineEventManagerOptions = {
  readonly store: StateMachineStore;
  readonly jobs: LifecycleJobs;
  readonly pushJob: (runId: string, revision: number, time: number) => void;
  readonly emit: (type: string, payload: unknown) => void;
};

export class MachineEventManager {
  readonly #store: StateMachineStore;
  readonly #jobs: LifecycleJobs;
  readonly #pushJob: (runId: string, revision: number, time: number) => void;
  readonly #emit: (type: string, payload: unknown) => void;

  constructor(options: MachineEventManagerOptions) {
    this.#store = options.store;
    this.#jobs = options.jobs;
    this.#pushJob = options.pushJob;
    this.#emit = options.emit;
  }

  async notify(
    runId: string,
    event: MachineEvent,
    options: MachineNotifyOptions
  ): Promise<MachineNotifyReceipt> {
    if (!options.eventId) throw new Error("Machine events require an eventId");
    if (!event.type) throw new Error("Machine events require a non-empty type");
    const eventJson = serializeMachineValue(event, "Machine event payload");
    if (eventJson === null) {
      throw new Error("Machine events cannot be undefined");
    }
    const expiresAt = optionalTime(options.expiresAt);
    let wake = false;
    let receipt: MachineNotifyReceipt;

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
      const queueDepth =
        this.#store.sql<{ count: number }>(
          `SELECT count(*) AS count FROM cf_agents_state_machine_events
           WHERE run_id = ?`,
          runId
        )[0]?.count ?? 0;
      if (queueDepth >= MAX_EVENT_QUEUE_DEPTH) {
        throw new MachineEventQueueFullError(runId);
      }
      const now = Date.now();
      const sequence = this.insert(row, options.eventId, event, now, expiresAt);
      receipt = { status: "accepted", sequence };
      wake = this.wakeWaitingRun(row, event, now);
    });
    if (wake) await this.#jobs.rearm();
    if (receipt!.status === "accepted") {
      this.#emit("state-machine:event:accepted", {
        runId,
        eventId: options.eventId,
        type: event.type
      });
    }
    return receipt!;
  }

  take(
    row: MachineRunRow,
    claimedEventIds: string[],
    filter: MachineEventFilter
  ): MachineQueuedEvent | null {
    const event = this.#store
      .matchingEvents(row.run_id, filter.type, filter.key, Date.now())
      .find((candidate) => !claimedEventIds.includes(candidate.event_id));
    if (!event) return null;
    claimedEventIds.push(event.event_id);
    return this.fromRow(event);
  }

  consume(
    runId: string,
    eventIds: readonly string[],
    revision: number,
    now: number
  ): void {
    this.#store.consumeEvents(runId, eventIds, revision, now);
  }

  insert(
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

  wakeWaitingRun(
    row: MachineRunRow,
    event: MachineEvent,
    now: number
  ): boolean {
    if (
      row.status !== "waiting" ||
      row.wait_type !== event.type ||
      (row.wait_key !== null && row.wait_key !== event.key) ||
      (row.next_at !== null && now >= row.next_at)
    ) {
      return false;
    }
    this.#store.write(
      `UPDATE cf_agents_state_machine_runs
       SET status = 'running', updated_at = ?
       WHERE run_id = ? AND status = 'waiting' AND revision = ?`,
      [now, row.run_id, row.revision]
    );
    this.#pushJob(row.run_id, row.revision, now);
    return true;
  }

  fromRow(row: MachineEventRow): MachineQueuedEvent {
    return {
      eventId: row.event_id,
      sequence: row.sequence,
      event: JSON.parse(row.payload_json),
      createdAt: row.created_at,
      ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {})
    };
  }

  wake(row: MachineRunRow): MachineWake {
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
}

function optionalTime(value: number | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  const time = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(time) || time < 0)
    throw new Error("Invalid Machine time");
  return Math.floor(time);
}
