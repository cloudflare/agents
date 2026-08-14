/**
 * The Engine (ADR 0001): behavioral service owning the Log, composed of the
 * deep sub-modules — Ledger, Consumers, Blobs, LogExport — plus
 * append/view/tail/fork. Implemented over the SqlDatabase seam so the same
 * code runs against DO SqlStorage and node:sqlite.
 *
 * Branch lineage: a fork's entries continue the parent's sequence numbering
 * from the fork point, so a lineage view has unique, totally ordered seqs and
 * `since(seq)` works transparently across the fork boundary.
 */

import type {
  AppendOptions,
  AppendResult,
  Blobs,
  BlobRef,
  BranchId,
  ClaimDecision,
  ClaimKey,
  ClaimRequest,
  Consumers,
  ConsumerName,
  DurableConsumer,
  EffectClaimedPayload,
  Engine,
  Entry,
  EntryId,
  EntryRef,
  Json,
  Ledger,
  Log,
  LogExport,
  LogView,
  NewEntry,
  Query,
  Reconciler,
  ReconcilerName,
  Seq,
  SettleOutcome,
  TailEvent,
  TailOptions,
  TurnId,
  Versioned
} from "../contract.js";
import type { Clock, SqlDatabase, SqlRow } from "../substrate.js";
import { assertBounded } from "./query.js";
import { ensureSchema } from "./schema.js";
import {
  asBlobId,
  asBranchId,
  asEntryId,
  asStepId,
  digest,
  ROOT_BRANCH,
  uuid
} from "../ids.js";

// ---------------------------------------------------------------------------
// Internal surface the runtime uses beyond the contract Engine
// ---------------------------------------------------------------------------

export interface EngineInternal {
  /** Fires after a batch commits, outside the transaction. */
  onCommitted(cb: (entries: readonly Entry[]) => void): () => void;
  /** Fires for ephemeral live-step events. */
  onLive(cb: (ev: TailEvent) => void): () => void;
  /**
   * Drive due open claims through their reconcilers once. Returns the epoch ms
   * of the next due claim, or null when nothing is open.
   */
  reconcilePass(now: number): Promise<number | null>;
  /** Emit an ephemeral live chunk (backs TurnDeps.write). */
  emitChunk(turn: TurnId, step: string, chunk: Json): void;
}

export interface CreatedEngine {
  readonly engine: Engine;
  readonly internal: EngineInternal;
}

interface BranchRow {
  id: string;
  parent_branch: string | null;
  fork_seq: number | null;
  next_seq: number;
}

const num = (v: SqlRow[string]): number => v as number;
const str = (v: SqlRow[string]): string => v as string;

export function createEngine(db: SqlDatabase, clock: Clock): CreatedEngine {
  ensureSchema(db);
  if (
    db.exec("SELECT id FROM rb_branches WHERE id = ?", ROOT_BRANCH).length === 0
  ) {
    db.exec(
      "INSERT INTO rb_branches (id, parent_branch, fork_seq, next_seq) VALUES (?, NULL, NULL, 1)",
      ROOT_BRANCH
    );
  }

  const committedListeners = new Set<(entries: readonly Entry[]) => void>();
  const liveListeners = new Set<(ev: TailEvent) => void>();
  const reconcilers = new Map<ReconcilerName, Reconciler>();
  const warnedMissingReconcilers = new Set<string>();

  function emitCommitted(entries: readonly Entry[]): void {
    for (const cb of committedListeners) cb(entries);
    for (const cb of liveListeners)
      for (const entry of entries) cb({ type: "entry", entry });
  }
  function emitLive(ev: TailEvent): void {
    for (const cb of liveListeners) cb(ev);
  }

  // -- lineage ---------------------------------------------------------------

  /** [own branch (no cap), ...ancestors (capped at fork seq)] */
  function lineage(
    branch: BranchId
  ): Array<{ branch: string; cap: number | null }> {
    const chain: Array<{ branch: string; cap: number | null }> = [];
    let current: string | null = branch;
    let cap: number | null = null;
    while (current !== null) {
      const rows = db.exec(
        "SELECT id, parent_branch, fork_seq, next_seq FROM rb_branches WHERE id = ?",
        current
      ) as unknown as BranchRow[];
      if (rows.length === 0) throw new Error(`unknown branch: ${current}`);
      chain.push({ branch: current, cap });
      cap = rows[0].fork_seq;
      current = rows[0].parent_branch;
    }
    return chain;
  }

  function lineageWhere(branch: BranchId, params: unknown[]): string {
    const parts = lineage(branch).map((seg) => {
      if (seg.cap === null) {
        params.push(seg.branch);
        return "(branch = ?)";
      }
      params.push(seg.branch, seg.cap);
      return "(branch = ? AND seq <= ?)";
    });
    return `(${parts.join(" OR ")})`;
  }

  // -- rows <-> entries ------------------------------------------------------

  function rowToEntry(row: SqlRow): Entry {
    const payload = JSON.parse(str(row.payload_json)) as Versioned;
    const entry: {
      ref: EntryRef;
      at: number;
      origin: { module: string; instance?: string };
      turn?: TurnId;
      correlation?: string;
      payload: Versioned;
    } = {
      ref: {
        branch: asBranchId(str(row.branch)),
        seq: num(row.seq),
        id: asEntryId(str(row.id))
      },
      at: num(row.at),
      origin:
        row.origin_instance === null
          ? { module: str(row.origin_module) }
          : {
              module: str(row.origin_module),
              instance: str(row.origin_instance)
            },
      payload
    };
    if (row.turn !== null) entry.turn = str(row.turn) as TurnId;
    if (row.correlation !== null) entry.correlation = str(row.correlation);
    return entry as Entry;
  }

  // -- append ----------------------------------------------------------------

  function insertEntries(
    branch: BranchId,
    entries: readonly NewEntry[]
  ): Entry[] {
    const at = clock.now();
    const rows = db.exec(
      "SELECT next_seq FROM rb_branches WHERE id = ?",
      branch
    );
    if (rows.length === 0) throw new Error(`unknown branch: ${branch}`);
    let seq = num(rows[0].next_seq);
    const committed: Entry[] = [];
    for (const e of entries) {
      const id = asEntryId(uuid());
      db.exec(
        `INSERT INTO rb_entries
           (branch, seq, id, at, origin_module, origin_instance, turn, correlation, kind, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        branch,
        seq,
        id,
        at,
        e.origin.module,
        e.origin.instance ?? null,
        e.turn ?? null,
        e.correlation ?? null,
        e.payload.kind,
        JSON.stringify(e.payload)
      );
      const entry: Record<string, unknown> = {
        ref: { branch, seq, id },
        at,
        origin: e.origin,
        payload: e.payload
      };
      if (e.turn !== undefined) entry.turn = e.turn;
      if (e.correlation !== undefined) entry.correlation = e.correlation;
      committed.push(entry as unknown as Entry);
      seq += 1;
    }
    db.exec("UPDATE rb_branches SET next_seq = ? WHERE id = ?", seq, branch);
    return committed;
  }

  function append(
    entries: readonly NewEntry[],
    opts?: AppendOptions
  ): AppendResult {
    const branch = opts?.branch ?? ROOT_BRANCH;
    let result: AppendResult | null = null;
    let committed: Entry[] = [];
    db.transaction(() => {
      if (opts?.idempotencyKey !== undefined) {
        const existing = db.exec(
          "SELECT content_digest, refs_json FROM rb_append_idempotency WHERE key = ?",
          opts.idempotencyKey
        );
        if (existing.length > 0) {
          const contentDigest = digest(
            JSON.stringify(entries.map((e) => e.payload))
          );
          if (str(existing[0].content_digest) !== contentDigest) {
            throw new Error(
              `idempotency key reused with different content: ${opts.idempotencyKey}`
            );
          }
          result = {
            outcome: "duplicate",
            refs: JSON.parse(str(existing[0].refs_json)) as EntryRef[]
          };
          return;
        }
      }
      if (opts?.expectedHead !== undefined) {
        const h = headRef(branch);
        if (h === null || h.id !== opts.expectedHead.id) {
          result = { outcome: "conflict", head: h ?? opts.expectedHead };
          return;
        }
      }
      committed = insertEntries(branch, entries);
      const refs = committed.map((e) => e.ref);
      if (opts?.idempotencyKey !== undefined) {
        db.exec(
          "INSERT INTO rb_append_idempotency (key, content_digest, refs_json) VALUES (?, ?, ?)",
          opts.idempotencyKey,
          digest(JSON.stringify(entries.map((e) => e.payload))),
          JSON.stringify(refs)
        );
      }
      result = { outcome: "committed", refs };
    });
    if (result === null) throw new Error("append produced no result");
    if (
      (result as AppendResult).outcome === "committed" &&
      committed.length > 0
    ) {
      emitCommitted(committed);
    }
    return result;
  }

  function headRef(branch: BranchId): EntryRef | null {
    const params: unknown[] = [];
    const where = lineageWhere(branch, params);
    const rows = db.exec(
      `SELECT branch, seq, id FROM rb_entries WHERE ${where} ORDER BY seq DESC LIMIT 1`,
      ...params
    );
    if (rows.length === 0) return null;
    return {
      branch: asBranchId(str(rows[0].branch)),
      seq: num(rows[0].seq),
      id: asEntryId(str(rows[0].id))
    };
  }

  // -- LogView ---------------------------------------------------------------

  function view(branch: BranchId = ROOT_BRANCH): LogView {
    return {
      branch,
      async head() {
        return headRef(branch);
      },
      async get(id: EntryId) {
        const params: unknown[] = [];
        const where = lineageWhere(branch, params);
        const rows = db.exec(
          `SELECT * FROM rb_entries WHERE id = ? AND ${where}`,
          id,
          ...params
        );
        return rows.length === 0 ? null : rowToEntry(rows[0]);
      },
      async getBlob(ref: BlobRef) {
        return blobs.getBlob(ref);
      },
      async query(q: Query) {
        assertBounded(q);
        const params: unknown[] = [];
        const clauses: string[] = [lineageWhere(branch, params)];
        if (q.kinds !== undefined && q.kinds.length > 0) {
          clauses.push(`kind IN (${q.kinds.map(() => "?").join(", ")})`);
          params.push(...q.kinds);
        }
        if (q.correlation !== undefined) {
          clauses.push("correlation = ?");
          params.push(q.correlation);
        }
        if (q.turn !== undefined) {
          clauses.push("turn = ?");
          params.push(q.turn);
        }
        if (q.after !== undefined) {
          clauses.push("seq > ?");
          params.push(q.after);
        }
        if (q.before !== undefined) {
          clauses.push("seq < ?");
          params.push(q.before);
        }
        const limit =
          q.limit !== undefined ? ` LIMIT ${Math.floor(q.limit)}` : "";
        const rows = db.exec(
          `SELECT * FROM rb_entries WHERE ${clauses.join(" AND ")} ORDER BY seq DESC${limit}`,
          ...params
        );
        return rows.map(rowToEntry);
      }
    };
  }

  // -- Ledger ----------------------------------------------------------------

  const ledger: Ledger = {
    async claim(req: ClaimRequest): Promise<ClaimDecision> {
      let decision: ClaimDecision | null = null;
      let committed: Entry[] = [];
      db.transaction(() => {
        const rows = db.exec("SELECT * FROM rb_claims WHERE key = ?", req.key);
        if (rows.length > 0) {
          const row = rows[0];
          const entryRef = refOfEntryId(str(row.claim_entry_id));
          if (str(row.status) === "open") {
            decision = {
              outcome: "duplicate-open",
              entry: entryRef,
              claimedAt: num(row.claimed_at)
            };
          } else {
            decision = {
              outcome: "already-settled",
              result: JSON.parse(str(row.result_json)) as SettleOutcome
            };
          }
          return;
        }
        const payload: EffectClaimedPayload = {
          kind: "effect/claimed",
          v: 1,
          key: req.key,
          effect: req.effect,
          input: req.input,
          inputDigest: digest(JSON.stringify(req.input))
        };
        const newEntry: Record<string, unknown> = {
          origin: req.origin,
          payload
        };
        if (req.turn !== undefined) newEntry.turn = req.turn;
        if (req.correlation !== undefined)
          newEntry.correlation = req.correlation;
        committed = insertEntries(ROOT_BRANCH, [
          newEntry as unknown as NewEntry
        ]);
        const entry = committed[0];
        const now = clock.now();
        db.exec(
          `INSERT INTO rb_claims
             (key, effect, status, claim_entry_id, reconciler, reconcile_after_ms,
              claimed_at, next_check_at, attempt, turn, correlation)
           VALUES (?, ?, 'open', ?, ?, ?, ?, ?, 0, ?, ?)`,
          req.key,
          req.effect,
          entry.ref.id,
          req.reconciler,
          req.reconcileAfterMs,
          now,
          now + req.reconcileAfterMs,
          req.turn ?? null,
          req.correlation ?? null
        );
        decision = { outcome: "acquired", entry: entry.ref };
      });
      if (committed.length > 0) emitCommitted(committed);
      if (decision === null) throw new Error("claim produced no decision");
      return decision;
    },

    async settle(key: ClaimKey, result: SettleOutcome): Promise<void> {
      let committed: Entry[] = [];
      db.transaction(() => {
        const rows = db.exec("SELECT * FROM rb_claims WHERE key = ?", key);
        if (rows.length === 0)
          throw new Error(`settle of unknown claim: ${key}`);
        if (str(rows[0].status) === "settled") return; // idempotent
        const newEntry: Record<string, unknown> = {
          origin: { module: "ledger" },
          payload: { kind: "effect/settled", v: 1, key, result }
        };
        if (rows[0].turn !== null) newEntry.turn = str(rows[0].turn);
        if (rows[0].correlation !== null)
          newEntry.correlation = str(rows[0].correlation);
        committed = insertEntries(ROOT_BRANCH, [
          newEntry as unknown as NewEntry
        ]);
        db.exec(
          "UPDATE rb_claims SET status = 'settled', settle_entry_id = ?, result_json = ? WHERE key = ?",
          committed[0].ref.id,
          JSON.stringify(result),
          key
        );
      });
      if (committed.length > 0) emitCommitted(committed);
    },

    async openClaims(filter?: { effectPrefix?: string }) {
      const params: unknown[] = [];
      let where = "status = 'open'";
      if (filter?.effectPrefix !== undefined) {
        where += " AND effect LIKE ?";
        params.push(`${filter.effectPrefix}%`);
      }
      const rows = db.exec(
        `SELECT claim_entry_id FROM rb_claims WHERE ${where} ORDER BY claimed_at ASC`,
        ...params
      );
      return rows.map(
        (r) => entryById(str(r.claim_entry_id)) as Entry<EffectClaimedPayload>
      );
    },

    async openClaimByCorrelation(correlation) {
      const rows = db.exec(
        "SELECT claim_entry_id FROM rb_claims WHERE status = 'open' AND correlation = ?",
        correlation
      );
      return rows.length === 0
        ? null
        : (entryById(
            str(rows[0].claim_entry_id)
          ) as Entry<EffectClaimedPayload>);
    },

    reconciler(name: ReconcilerName, reconciler: Reconciler): void {
      reconcilers.set(name, reconciler);
    }
  };

  function entryById(id: string): Entry {
    const rows = db.exec("SELECT * FROM rb_entries WHERE id = ?", id);
    if (rows.length === 0) throw new Error(`unknown entry: ${id}`);
    return rowToEntry(rows[0]);
  }

  function refOfEntryId(id: string): EntryRef {
    return entryById(id).ref;
  }

  // -- Consumers -------------------------------------------------------------

  const consumers: Consumers = {
    consumer(name: ConsumerName, opts): DurableConsumer {
      if (
        db.exec("SELECT name FROM rb_consumers WHERE name = ?", name).length ===
        0
      ) {
        db.exec("INSERT INTO rb_consumers (name, cursor) VALUES (?, 0)", name);
      }
      const filter = opts?.filter;
      return {
        name,
        async pull(max = 32) {
          const cursorRow = db.exec(
            "SELECT cursor FROM rb_consumers WHERE name = ?",
            name
          );
          const cursor = num(cursorRow[0].cursor);
          const params: unknown[] = [ROOT_BRANCH, cursor];
          const clauses = ["branch = ?", "seq > ?"];
          if (filter?.kinds !== undefined && filter.kinds.length > 0) {
            clauses.push(`kind IN (${filter.kinds.map(() => "?").join(", ")})`);
            params.push(...filter.kinds);
          }
          if (filter?.correlation !== undefined) {
            clauses.push("correlation = ?");
            params.push(filter.correlation);
          }
          if (filter?.turn !== undefined) {
            clauses.push("turn = ?");
            params.push(filter.turn);
          }
          const rows = db.exec(
            `SELECT * FROM rb_entries WHERE ${clauses.join(" AND ")}
             ORDER BY seq ASC LIMIT ${Math.floor(max)}`,
            ...params
          );
          if (rows.length === 0) return null;
          return {
            entries: rows.map(rowToEntry),
            cursor: num(rows[rows.length - 1].seq)
          };
        },
        async ack(cursor: Seq) {
          db.exec(
            "UPDATE rb_consumers SET cursor = ? WHERE name = ?",
            cursor,
            name
          );
        }
      };
    }
  };

  // -- Blobs -----------------------------------------------------------------

  const blobs: Blobs = {
    async putBlob(data, meta) {
      const bytes =
        data instanceof Uint8Array ? data : await collectStream(data);
      const id = asBlobId(uuid());
      db.exec(
        "INSERT INTO rb_blobs (id, media_type, bytes, data) VALUES (?, ?, ?, ?)",
        id,
        meta.mediaType,
        bytes.byteLength,
        bytes
      );
      return { blob: id, bytes: bytes.byteLength, mediaType: meta.mediaType };
    },
    async getBlob(ref) {
      const rows = db.exec("SELECT data FROM rb_blobs WHERE id = ?", ref.blob);
      if (rows.length === 0) throw new Error(`unknown blob: ${ref.blob}`);
      const bytes = rows[0].data as Uint8Array;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        }
      });
    }
  };

  // -- Export ----------------------------------------------------------------

  const logExport: LogExport = {
    async *scan(branch: BranchId, from?: Seq) {
      let cursor = from ?? 0;
      for (;;) {
        const params: unknown[] = [];
        const where = lineageWhere(branch, params);
        const rows = db.exec(
          `SELECT * FROM rb_entries WHERE ${where} AND seq >= ?
           ORDER BY seq ASC LIMIT 100`,
          ...params,
          cursor
        );
        if (rows.length === 0) return;
        for (const row of rows) yield rowToEntry(row);
        cursor = num(rows[rows.length - 1].seq) + 1;
      }
    }
  };

  // -- Tail ------------------------------------------------------------------

  async function* tail(opts?: TailOptions): AsyncGenerator<TailEvent> {
    const branch = opts?.branch ?? ROOT_BRANCH;
    const queue: TailEvent[] = [];
    let notify: (() => void) | null = null;
    const push = (ev: TailEvent) => {
      if (ev.type === "entry") {
        if (ev.entry.ref.branch !== branch) return;
        const f = opts?.filter;
        if (f?.kinds !== undefined && !f.kinds.includes(ev.entry.payload.kind))
          return;
        if (
          f?.correlation !== undefined &&
          ev.entry.correlation !== f.correlation
        )
          return;
        if (f?.turn !== undefined && ev.entry.turn !== f.turn) return;
      } else if (opts?.live !== true) {
        return;
      }
      queue.push(ev);
      notify?.();
    };
    liveListeners.add(push);
    try {
      if (opts?.from !== undefined) {
        const backlog = await view(branch).query({
          after: opts.from,
          ...opts.filter
        });
        for (const entry of [...backlog].reverse())
          yield { type: "entry", entry };
      }
      for (;;) {
        while (queue.length > 0) yield queue.shift() as TailEvent;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
    } finally {
      liveListeners.delete(push);
    }
  }

  // -- fork ------------------------------------------------------------------

  async function fork(at: EntryRef): Promise<BranchId> {
    const child = asBranchId(uuid());
    db.exec(
      "INSERT INTO rb_branches (id, parent_branch, fork_seq, next_seq) VALUES (?, ?, ?, ?)",
      child,
      at.branch,
      at.seq,
      at.seq + 1
    );
    return child;
  }

  // -- reconcile pass --------------------------------------------------------

  async function reconcilePass(now: number): Promise<number | null> {
    const due = db.exec(
      "SELECT * FROM rb_claims WHERE status = 'open' AND next_check_at <= ? ORDER BY next_check_at ASC LIMIT 16",
      now
    );
    for (const row of due) {
      const key = str(row.key) as ClaimKey;
      const name = str(row.reconciler) as ReconcilerName;
      const reconciler = reconcilers.get(name);
      if (reconciler === undefined) {
        if (!warnedMissingReconcilers.has(name)) {
          warnedMissingReconcilers.add(name);
          console.warn(`[rebuild] no reconciler registered under "${name}"`);
        }
        db.exec(
          "UPDATE rb_claims SET next_check_at = ? WHERE key = ?",
          now + 60_000,
          key
        );
        continue;
      }
      const attempt = num(row.attempt) + 1;
      if (attempt > reconciler.policy.maxAttempts) {
        await ledger.settle(key, {
          status: "expired",
          reason: `reconcile attempts exhausted (${reconciler.policy.maxAttempts})`
        });
        continue;
      }
      // Persist the attempt before invoking: a crash mid-handle still counts.
      db.exec("UPDATE rb_claims SET attempt = ? WHERE key = ?", attempt, key);
      const claimEntry = entryById(
        str(row.claim_entry_id)
      ) as Entry<EffectClaimedPayload>;
      try {
        const outcome = await reconciler.handle({
          claim: claimEntry,
          attempt,
          policy: reconciler.policy,
          view: view(ROOT_BRANCH)
        });
        if (outcome.action === "settle") {
          await ledger.settle(key, outcome.result);
        } else {
          const backoff = Math.min(
            reconciler.policy.backoff.initialMs *
              reconciler.policy.backoff.factor ** (attempt - 1),
            reconciler.policy.backoff.maxMs
          );
          const delay = outcome.afterMs ?? backoff;
          const uncounted = outcome.action === "wait" ? 1 : 0;
          db.exec(
            "UPDATE rb_claims SET next_check_at = ?, attempt = attempt - ? WHERE key = ?",
            now + delay,
            uncounted,
            key
          );
        }
      } catch (error) {
        const backoff = Math.min(
          reconciler.policy.backoff.initialMs *
            reconciler.policy.backoff.factor ** (attempt - 1),
          reconciler.policy.backoff.maxMs
        );
        console.warn(`[rebuild] reconciler "${name}" threw:`, error);
        db.exec(
          "UPDATE rb_claims SET next_check_at = ? WHERE key = ?",
          now + backoff,
          key
        );
      }
    }
    const next = db.exec(
      "SELECT MIN(next_check_at) AS n FROM rb_claims WHERE status = 'open'"
    );
    return next.length > 0 && next[0].n !== null ? num(next[0].n) : null;
  }

  const log: Log = { root: ROOT_BRANCH };

  const engine: Engine = {
    log,
    ledger,
    consumers,
    blobs,
    export: logExport,
    append: async (entries, opts) => append(entries, opts),
    view,
    tail,
    fork
  };

  const internal: EngineInternal = {
    onCommitted(cb) {
      committedListeners.add(cb);
      return () => committedListeners.delete(cb);
    },
    onLive(cb) {
      liveListeners.add(cb);
      return () => liveListeners.delete(cb);
    },
    reconcilePass,
    emitChunk(turn, step, chunk) {
      emitLive({ type: "chunk", chunk: { turn, step: asStepId(step), chunk } });
    }
  };

  return { engine, internal };
}

async function collectStream(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
