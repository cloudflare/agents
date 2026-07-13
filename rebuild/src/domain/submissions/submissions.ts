import { ConflictError, ValidationError, toErrorValue } from "../../kernel/errors.js";
import type { EventBus } from "../../kernel/events.js";
import type { IdSource } from "../../kernel/ids.js";
import type { Clock } from "../../ports/clock.js";
import { scoped, type KeyValueStore } from "../../ports/storage.js";
import type { ChatMessage } from "../messages/model.js";

export type SubmissionStatus = "pending" | "running" | "completed" | "aborted" | "skipped" | "error";

export interface SubmissionRecord {
  submissionId: string;
  status: SubmissionStatus;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  acceptedAt: number;
  startedAt?: number;
  settledAt?: number;
  error?: string;
  messageCount: number;
}

export interface SubmissionService {
  submit(
    messages: ChatMessage[],
    options?: { submissionId?: string; idempotencyKey?: string; metadata?: Record<string, unknown> }
  ): Promise<SubmissionRecord & { accepted: boolean }>;
  inspect(submissionId: string): SubmissionRecord | null;
  list(options?: { status?: SubmissionStatus[]; limit?: number }): SubmissionRecord[];
  cancel(submissionId: string, reason?: string): Promise<boolean>;
  deleteSubmissions(options?: { status?: SubmissionStatus[]; completedBefore?: number }): number;
  markAllPendingSkipped(): number;
  drain(): Promise<void>;
}

type RunOutcome = { kind: "completed" | "aborted" | "error"; error?: string };

interface InternalRow extends Omit<SubmissionRecord, "messageCount"> {
  seq: number;
  messages: ChatMessage[];
}

const SETTLED_STATUSES: SubmissionStatus[] = ["completed", "aborted", "skipped", "error"];
const ROW_PREFIX = "rec:";
const IDEM_PREFIX = "idem:";
const SEQ_KEY = "seq";

function assertSerializable(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (typeof value === "function" || typeof value === "symbol") {
    throw new ValidationError("Submission messages must be JSON-serializable (no functions/symbols/closures)");
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) {
    throw new ValidationError("Submission messages must be JSON-serializable (no cyclic references)");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertSerializable(item, seen);
    return;
  }
  for (const v of Object.values(value as Record<string, unknown>)) assertSerializable(v, seen);
}

export function createSubmissionService(deps: {
  store: KeyValueStore;
  clock: Clock;
  ids: IdSource;
  bus: EventBus;
  runSubmission: (
    record: { submissionId: string; messages: ChatMessage[] },
    signal: AbortSignal
  ) => Promise<RunOutcome>;
}): SubmissionService {
  const kv = scoped(deps.store, "subm:");
  const running = new Map<string, AbortController>();
  let draining = false;

  function toPublic(row: InternalRow): SubmissionRecord {
    return {
      submissionId: row.submissionId,
      status: row.status,
      idempotencyKey: row.idempotencyKey,
      metadata: row.metadata,
      acceptedAt: row.acceptedAt,
      startedAt: row.startedAt,
      settledAt: row.settledAt,
      error: row.error,
      messageCount: row.messages.length,
    };
  }

  function getRow(submissionId: string): InternalRow | undefined {
    return kv.get<InternalRow>(`${ROW_PREFIX}${submissionId}`);
  }

  function saveRow(row: InternalRow): void {
    kv.put(`${ROW_PREFIX}${row.submissionId}`, row);
  }

  function allRows(): InternalRow[] {
    return [...kv.list<InternalRow>({ prefix: ROW_PREFIX }).values()];
  }

  function nextSeq(): number {
    const current = kv.get<number>(SEQ_KEY) ?? 0;
    const next = current + 1;
    kv.put(SEQ_KEY, next);
    return next;
  }

  function getByIdempotencyKey(key: string): InternalRow | undefined {
    const submissionId = kv.get<string>(`${IDEM_PREFIX}${key}`);
    return submissionId ? getRow(submissionId) : undefined;
  }

  function scheduleDrain(): void {
    setTimeout(() => {
      void drain();
    }, 0);
  }

  function claimOldestPending(): InternalRow | undefined {
    const pending = allRows()
      .filter((r) => r.status === "pending")
      .sort((a, b) => a.seq - b.seq);
    const row = pending[0];
    if (!row) return undefined;
    row.status = "running";
    row.startedAt = deps.clock.now();
    saveRow(row);
    deps.bus.emit("chat:submission:started", { submissionId: row.submissionId });
    return row;
  }

  async function runOne(row: InternalRow): Promise<void> {
    const controller = new AbortController();
    running.set(row.submissionId, controller);
    let outcome: RunOutcome;
    try {
      outcome = await deps.runSubmission({ submissionId: row.submissionId, messages: row.messages }, controller.signal);
    } catch (err) {
      outcome = { kind: "error", error: toErrorValue(err).message };
    } finally {
      running.delete(row.submissionId);
    }

    const fresh = getRow(row.submissionId);
    if (!fresh || fresh.status !== "running") {
      // Settled out-of-band (e.g. cancelled) while running — don't clobber.
      return;
    }
    if (outcome.kind === "completed") {
      fresh.status = "completed";
    } else if (outcome.kind === "aborted") {
      fresh.status = "aborted";
    } else {
      fresh.status = "error";
      fresh.error = outcome.error;
    }
    fresh.settledAt = deps.clock.now();
    saveRow(fresh);
    deps.bus.emit("chat:submission:settled", { submissionId: fresh.submissionId, status: fresh.status });
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const row = claimOldestPending();
        if (!row) break;
        await runOne(row);
      }
    } finally {
      draining = false;
    }
  }

  // Pick up any rows left `pending` by a previous instance over the same store.
  scheduleDrain();

  return {
    async submit(messages, options) {
      if (messages.length < 1) {
        throw new ValidationError("submit() requires at least one message");
      }
      assertSerializable(messages);

      const suppliedId = options?.submissionId;
      const key = options?.idempotencyKey;
      const existingById = suppliedId ? getRow(suppliedId) : undefined;
      const existingByKey = key ? getByIdempotencyKey(key) : undefined;

      if (existingById && existingByKey && existingById.submissionId !== existingByKey.submissionId) {
        throw new ConflictError(
          `submissionId ${suppliedId} and idempotencyKey ${key} refer to different submissions`
        );
      }

      const existing = existingByKey ?? existingById;
      if (existing) {
        return { ...toPublic(existing), accepted: false };
      }

      const submissionId = suppliedId ?? deps.ids.newId("subm");
      const now = deps.clock.now();
      const row: InternalRow = {
        submissionId,
        seq: nextSeq(),
        status: "pending",
        idempotencyKey: key,
        metadata: options?.metadata,
        acceptedAt: now,
        messages,
      };
      saveRow(row);
      if (key) kv.put(`${IDEM_PREFIX}${key}`, submissionId);
      deps.bus.emit("chat:submission:accepted", { submissionId });

      scheduleDrain();

      return { ...toPublic(row), accepted: true };
    },

    inspect(submissionId) {
      const row = getRow(submissionId);
      return row ? toPublic(row) : null;
    },

    list(options) {
      let rows = allRows().sort((a, b) => a.seq - b.seq);
      if (options?.status) {
        const statuses = options.status;
        rows = rows.filter((r) => statuses.includes(r.status));
      }
      if (options?.limit !== undefined) {
        rows = rows.slice(0, options.limit);
      }
      return rows.map(toPublic);
    },

    async cancel(submissionId, reason) {
      const row = getRow(submissionId);
      if (!row) return false;

      if (row.status === "pending") {
        row.status = "aborted";
        row.settledAt = deps.clock.now();
        saveRow(row);
        deps.bus.emit("chat:submission:cancelled", { submissionId, reason });
        return true;
      }

      if (row.status === "running") {
        const controller = running.get(submissionId);
        row.status = "aborted";
        row.settledAt = deps.clock.now();
        saveRow(row);
        controller?.abort(reason);
        deps.bus.emit("chat:submission:cancelled", { submissionId, reason });
        return true;
      }

      return false;
    },

    deleteSubmissions(options) {
      const statuses = options?.status ?? SETTLED_STATUSES;
      let count = 0;
      for (const row of allRows()) {
        if (!statuses.includes(row.status)) continue;
        if (options?.completedBefore !== undefined) {
          if (row.settledAt === undefined || !(row.settledAt < options.completedBefore)) continue;
        }
        kv.delete(`${ROW_PREFIX}${row.submissionId}`);
        if (row.idempotencyKey) kv.delete(`${IDEM_PREFIX}${row.idempotencyKey}`);
        count++;
      }
      return count;
    },

    markAllPendingSkipped() {
      let count = 0;
      for (const row of allRows()) {
        if (row.status !== "pending") continue;
        row.status = "skipped";
        row.settledAt = deps.clock.now();
        saveRow(row);
        count++;
      }
      return count;
    },

    drain,
  };
}
