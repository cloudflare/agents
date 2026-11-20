/**
 * Durable admission of client requests, shared by `AIChatAgent` and `Think`.
 *
 * A client request stores its user messages before it waits in the turn
 * queue, and the queue lives in memory. When an isolate resets (a deploy, an
 * eviction, a crash) while one turn runs and others wait behind it, only the
 * running turn has a fiber, so only it is recovered. A request that was
 * accepted and was waiting used to be lost: its user message stayed in the
 * transcript with no reply, and the tab that sent it never got a terminal
 * frame.
 *
 * The rule, checked in `ChatAdmission.tla`:
 *
 * - every accepted request writes a record before it stores its messages:
 *   its request id, the ids of the user messages it stores, its concurrency
 *   decision, and what the host needs to run it again (tools, body,
 *   trigger);
 * - the record goes when the request's turn has a fiber (recovery owns the
 *   turn from then on) and when the request ends without one;
 * - a stop by the request id is written on the record, and a clear deletes
 *   every record;
 * - after a reset, once no interrupted turn waits for recovery, the records
 *   left are queued again in order, each as its own turn under its own
 *   request id. A new request replays them first, ahead of itself, without
 *   waiting for recovery;
 * - a record whose request has a turn that recovery knows (it had a fiber)
 *   is left to recovery, and a record whose messages are gone ends
 *   `skipped`.
 *
 * The store is the host's, behind {@link ChatAdmissionStore}. An object
 * written by an older release has no records, and an older release never
 * reads the table.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { AgentToolSql } from "./agent-tool-run-store";
import type { NormalizedMessageConcurrency } from "./submit-concurrency";

/** The concurrency decision a request was accepted with, as stored. */
export interface StoredSubmitDecision {
  strategy: NormalizedMessageConcurrency | null;
  /**
   * Whether the request overlapped a queued turn under a policy that can
   * supersede it (`latest`, `merge`, `debounce`). A replay gives it a new
   * sequence number, in record order.
   */
  overlapping: boolean;
  debounceUntilMs: number | null;
}

/** One accepted request that has no turn with a fiber yet. */
export interface ChatAdmissionRecord {
  requestId: string;
  /** Admission order. */
  seq: number;
  /** The user messages the request stores. A replay needs them stored. */
  messageIds: string[];
  decision: StoredSubmitDecision;
  /** What the host needs to run the request again. JSON. */
  payload: unknown;
  /** A stop by the request id landed while it had no fiber. */
  stopped: boolean;
  createdAt: number;
}

/** Where a host keeps admission records. Synchronous, like DO SQLite. */
export interface ChatAdmissionStore {
  /** Write a record. Its `seq` follows every record written before it. */
  add(record: {
    requestId: string;
    messageIds: string[];
    decision: StoredSubmitDecision;
    payload: unknown;
  }): void;
  /** Delete a record. Nothing happens when there is none. */
  remove(requestId: string): void;
  /** Mark a record stopped. Nothing happens when there is none. */
  stop(requestId: string): void;
  /** Mark every record stopped. */
  stopAll(): void;
  /** Delete every record. */
  clear(): void;
  /** Every record, in admission order. */
  list(): ChatAdmissionRecord[];
}

/**
 * A record older than this is dropped, not replayed: an hour, the life of a
 * recovery incident. One can only be that old if a release without durable
 * admission ran in between (a rollback), and that release has already let
 * the request go.
 */
export const CHAT_ADMISSION_TTL_MS = 60 * 60 * 1000;

/** The table admission records live in. */
export const CHAT_ADMISSIONS_TABLE = "cf_agents_chat_admissions";

/**
 * A {@link ChatAdmissionStore} on the host's SQLite. The table is created on
 * first use, so an object that never queues a request pays nothing for it.
 */
export function createChatAdmissionStore(
  sql: () => AgentToolSql,
  table: string = CHAT_ADMISSIONS_TABLE
): ChatAdmissionStore {
  const run = (query: string, ...bindings: unknown[]) =>
    sql()
      .exec(query, ...bindings)
      .toArray();
  let ready = false;
  const ensure = (): void => {
    if (ready) return;
    run(
      `create table if not exists ${table} (
        request_id text primary key,
        seq integer not null,
        message_ids text not null,
        decision text not null,
        payload text,
        stopped integer not null default 0,
        created_at integer not null
      )`
    );
    ready = true;
  };
  return {
    add(record) {
      ensure();
      run(
        `insert or replace into ${table}
           (request_id, seq, message_ids, decision, payload, stopped, created_at)
         select ?, coalesce(max(seq), 0) + 1, ?, ?, ?, 0, ? from ${table}`,
        record.requestId,
        JSON.stringify(record.messageIds),
        JSON.stringify(record.decision),
        record.payload === undefined ? null : JSON.stringify(record.payload),
        Date.now()
      );
    },
    remove(requestId) {
      ensure();
      run(`delete from ${table} where request_id = ?`, requestId);
    },
    stop(requestId) {
      ensure();
      run(`update ${table} set stopped = 1 where request_id = ?`, requestId);
    },
    stopAll() {
      ensure();
      run(`update ${table} set stopped = 1`);
    },
    clear() {
      ensure();
      run(`delete from ${table}`);
    },
    list() {
      ensure();
      return run(
        `select request_id, seq, message_ids, decision, payload, stopped,
                created_at
         from ${table} order by seq`
      ).map((row) => ({
        requestId: String(row.request_id),
        seq: Number(row.seq),
        messageIds: parseJson<string[]>(row.message_ids) ?? [],
        decision: parseJson<StoredSubmitDecision>(row.decision) ?? {
          strategy: null,
          overlapping: false,
          debounceUntilMs: null
        },
        payload: parseJson<unknown>(row.payload),
        stopped: Number(row.stopped) === 1,
        createdAt: Number(row.created_at)
      }));
    }
  };
}

function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Whether a chat turn waits for recovery: a recovery incident that is still
 * live, or a chat-turn run (a Task run or a legacy fiber) that no turn in
 * this isolate owns, which recovery has not picked up yet.
 *
 * @param input.turnName - The host's chat-turn Task and fiber name.
 * @param input.liveRequestIds - Request ids of the turns running here.
 * @param input.requestId - Ask about this request only: whether a turn of
 *   it had a fiber, by an incident of any status or a run of any state.
 */
export async function chatRecoveryNames(input: {
  sql: AgentToolSql;
  storage: Pick<DurableObjectStorage, "list">;
  turnName: string;
  liveRequestIds: ReadonlySet<string>;
  requestId?: string;
}): Promise<boolean> {
  const { requestId } = input;
  const incidents = await input.storage.list<{
    status?: string;
    requestId?: string;
    recoveryRootRequestId?: string;
  }>({ prefix: "cf:chat-recovery:incident:" });
  for (const incident of incidents.values()) {
    if (!incident) continue;
    if (requestId === undefined) {
      if (
        incident.status === "detected" ||
        incident.status === "scheduled" ||
        incident.status === "attempting"
      ) {
        return true;
      }
    } else if (
      incident.requestId === requestId ||
      incident.recoveryRootRequestId === requestId
    ) {
      return true;
    }
  }
  for (const id of interruptedTurnRequestIds(input.sql, input.turnName)) {
    if (
      requestId === undefined ? !input.liveRequestIds.has(id) : id === requestId
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Request ids of chat-turn runs that have not settled: Task runs of the
 * turn definition, and legacy fibers (facets). A table that does not exist
 * yet holds none.
 */
function interruptedTurnRequestIds(
  sql: AgentToolSql,
  turnName: string
): string[] {
  const ids: string[] = [];
  try {
    for (const row of sql
      .exec(
        `select input from cf_agents_task_runs
         where definition = ? and state in ('pending', 'running', 'waiting')`,
        turnName
      )
      .toArray()) {
      const parsed = parseJson<{ requestId?: unknown }>(row.input);
      if (typeof parsed?.requestId === "string") ids.push(parsed.requestId);
    }
  } catch {
    // No Tasks table yet.
  }
  try {
    const prefix = `${turnName}:`;
    for (const row of sql
      .exec(
        `select name from cf_agents_runs where substr(name, 1, ?) = ?`,
        prefix.length,
        prefix
      )
      .toArray()) {
      ids.push(String(row.name).slice(prefix.length));
    }
  } catch {
    // No fiber table yet.
  }
  return ids;
}

/** What {@link ChatAdmissions} needs from the turn core and the host. */
export interface ChatAdmissionsHost {
  store: ChatAdmissionStore;
  /** Whether an interrupted turn still waits for recovery. */
  recoveryPending(): Promise<boolean>;
  /** Whether a turn of `requestId` had a fiber, so recovery owns it. */
  recoveryOwns(requestId: string): Promise<boolean>;
  /**
   * The records about to be replayed, in order, before the first of them
   * is queued: their concurrency decisions are restored together, so a
   * request a later one superseded is superseded already when it reaches
   * the front of the queue.
   */
  beginReplay(records: ChatAdmissionRecord[]): void;
  /**
   * Run a record's request again. Call `onQueued` once it is on the turn
   * queue, or once it ended before it got there.
   */
  replay(record: ChatAdmissionRecord, onQueued: () => void): Promise<void>;
}

/**
 * The records of one chat, and their replay after a reset. See the module
 * comment for the rule.
 */
export class ChatAdmissions {
  /** Requests a process in this isolate owns. Their records are not orphans. */
  readonly live = new Set<string>();
  /** Records left by an earlier isolate may exist. Cleared after a replay. */
  #orphansMaybe = true;
  #replaying: Promise<void> | null = null;

  constructor(private readonly host: ChatAdmissionsHost) {}

  /** Record an accepted request, before its messages are stored. */
  admit(record: {
    requestId: string;
    messageIds: string[];
    decision: StoredSubmitDecision;
    payload: unknown;
  }): void {
    this.live.add(record.requestId);
    this.host.store.add(record);
  }

  /** The request's turn has a fiber, or the request ended without one. */
  release(requestId: string): void {
    this.host.store.remove(requestId);
  }

  /** The process that owned the request ended. */
  end(requestId: string): void {
    this.live.delete(requestId);
    this.host.store.remove(requestId);
  }

  stop(requestId: string): void {
    this.host.store.stop(requestId);
  }

  stopAll(): void {
    this.host.store.stopAll();
  }

  /** A clear: every record goes. */
  clear(): void {
    this.host.store.clear();
    this.#orphansMaybe = false;
  }

  /** The user messages of every request that has no turn with a fiber yet. */
  messageIds(): Set<string> {
    return new Set(this.host.store.list().flatMap((r) => r.messageIds));
  }

  /**
   * Queue the records an earlier isolate left, in order, each as its own
   * request. Unless `force`, nothing happens while an interrupted turn
   * still waits for recovery: the recovery's end calls this again.
   *
   * @returns Once every record is queued or ended. Not when their turns end.
   */
  async resume(options: { force?: boolean } = {}): Promise<void> {
    if (this.#replaying) return this.#replaying;
    if (!this.#orphansMaybe) return;
    const orphans = this.#orphans();
    if (orphans.length === 0) {
      this.#orphansMaybe = false;
      return;
    }
    if (!options.force && (await this.host.recoveryPending())) return;
    if (this.#replaying) return this.#replaying;
    const replaying = this.#replay();
    this.#replaying = replaying;
    try {
      await replaying;
    } finally {
      if (this.#replaying === replaying) this.#replaying = null;
    }
  }

  /**
   * A new request is about to join the queue: the records an earlier
   * isolate left go first, whether recovery is done or not.
   */
  async beforeEnqueue(): Promise<void> {
    if (!this.#orphansMaybe && !this.#replaying) return;
    await this.resume({ force: true });
  }

  #orphans(): ChatAdmissionRecord[] {
    return this.host.store.list().filter((r) => !this.live.has(r.requestId));
  }

  async #replay(): Promise<void> {
    const records: ChatAdmissionRecord[] = [];
    for (const record of this.#orphans()) {
      if (
        Date.now() - record.createdAt > CHAT_ADMISSION_TTL_MS ||
        (await this.host.recoveryOwns(record.requestId))
      ) {
        this.host.store.remove(record.requestId);
        continue;
      }
      records.push(record);
    }
    const replays = records.filter(
      (record) => !this.live.has(record.requestId)
    );
    for (const record of replays) this.live.add(record.requestId);
    this.host.beginReplay(replays);
    for (const record of replays) {
      await new Promise<void>((queued) => {
        this.host.replay(record, queued).then(
          () => queued(),
          (error: unknown) => {
            queued();
            console.error("[chat] a replayed request failed:", error);
          }
        );
      });
    }
    this.#orphansMaybe = this.#orphans().length > 0;
  }
}
