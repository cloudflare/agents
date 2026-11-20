/**
 * Durable admission of client requests, shared by `AIChatAgent` and `Think`.
 *
 * The turn queue lives in memory. When an isolate resets (a deploy, an
 * eviction, a crash) while one turn runs and others wait behind it, only the
 * running turn has a fiber, so only it is recovered. The record is what
 * keeps a waiting request.
 *
 * A request's new user messages are held on its record, not stored in the
 * transcript, until its turn reaches the front of the queue. A turn answers
 * its own message, and the transcript a model request is built from never
 * holds a later question than the one the turn answers: two queued
 * questions read `U1, A1, U2, A2`. Tabs see a waiting message at once: the
 * message lists the hosts send end with the held messages, named in
 * `queuedMessageIds` ({@link ChatAdmissions.waitingMessages}).
 *
 * The rules, checked in `ChatAdmission.tla` and `ChatOrder.tla`:
 *
 * - every accepted request writes a record when it is accepted: its request
 *   id, the user messages it holds, its concurrency decision, and what the
 *   host needs to run it again (tools, body, trigger);
 * - the held messages join the transcript at the front of the queue, once:
 *   a message already stored (a reset after the join) is not stored again;
 * - the record goes when the request's turn has a fiber (recovery owns the
 *   turn from then on) and when the request ends without one;
 * - a stop by the request id is written on the record, and a clear deletes
 *   every record;
 * - after a reset, once no interrupted turn waits for recovery, the records
 *   left are queued again in order, each as its own turn under its own
 *   request id. A new request replays them first, ahead of itself, without
 *   waiting for recovery;
 * - a record whose request has a turn that recovery knows (it had a fiber)
 *   is left to recovery. A replayed record whose conversation moved on
 *   without it (a user message nothing waits on follows the one it was
 *   accepted after: a rollback answered something newer) ends `skipped`
 *   with its messages never stored.
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

/**
 * The user messages a client request stores: the ones at the end of what it
 * sent that are not stored yet. A client sends its whole transcript, and
 * with windowed history `stored` holds only the newest messages, so an
 * older message outside the window is not one this request stores: only the
 * run after the last stored message counts.
 *
 * @param messages - What the request sent, oldest first.
 * @param stored - The ids of the stored messages the host holds in memory.
 */
export function newUserMessageIds(
  messages: ReadonlyArray<{ id: string; role: string }>,
  stored: ReadonlySet<string>
): string[] {
  const ids: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (stored.has(messages[i].id)) break;
    if (messages[i].role === "user") ids.unshift(messages[i].id);
  }
  return ids;
}

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

/** A message a request holds until its turn starts. JSON. */
export interface HeldChatMessage {
  id: string;
  role: string;
}

/** One accepted request that has no turn with a fiber yet. */
export interface ChatAdmissionRecord {
  requestId: string;
  /** Admission order. */
  seq: number;
  /** The ids of {@link messages}. */
  messageIds: string[];
  /**
   * The user messages the request holds until its turn starts, as the
   * client sent them. They join the transcript at the front of the queue.
   */
  messages: HeldChatMessage[];
  /**
   * The latest user message a tab showed when the request was accepted,
   * stored or waiting. A replay checks that no user message nothing waits
   * on came after it.
   */
  afterUserId: string | null;
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
    messages: HeldChatMessage[];
    afterUserId: string | null;
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
 * The longest piece of held-message JSON kept in one row. A JS string unit
 * is at most three bytes of UTF-8, so a piece stays under the 2 MB row
 * limit. Longer JSON (a message with large files) is split across rows of
 * the `_messages` table.
 */
const HELD_MESSAGES_PIECE = 500_000;

/**
 * A {@link ChatAdmissionStore} on the host's SQLite. The table is created on
 * first write, so an object that never takes a client request pays nothing
 * for it.
 */
export function createChatAdmissionStore(
  sql: () => AgentToolSql,
  table: string = CHAT_ADMISSIONS_TABLE
): ChatAdmissionStore {
  const run = (query: string, ...bindings: unknown[]) =>
    sql()
      .exec(query, ...bindings)
      .toArray();
  const pieces = `${table}_messages`;
  // Records whose messages are split into pieces, so a delete touches the
  // pieces table only for them.
  const withPieces = new Set<string>();
  let state: "unknown" | "absent" | "ready" = "unknown";
  const ensure = (): void => {
    if (state === "ready") return;
    run(
      `create table if not exists ${table} (
        request_id text primary key,
        seq integer not null,
        message_ids text not null,
        decision text not null,
        payload text,
        stopped integer not null default 0,
        created_at integer not null,
        messages text,
        message_pieces integer not null default 0,
        after_user_id text
      )`
    );
    // A table an earlier build of this release created has no held
    // messages. Its records read as holding none.
    const columns = new Set(
      run(`pragma table_info(${table})`).map((row) => String(row.name))
    );
    if (!columns.has("messages")) {
      run(`alter table ${table} add column messages text`);
      run(
        `alter table ${table} add column message_pieces integer not null default 0`
      );
      run(`alter table ${table} add column after_user_id text`);
    }
    run(
      `create table if not exists ${pieces} (
        request_id text not null,
        piece integer not null,
        data text not null,
        primary key (request_id, piece)
      )`
    );
    state = "ready";
  };
  /** Whether the table exists, without creating it. */
  const exists = (): boolean => {
    if (state === "ready") return true;
    if (state === "absent") return false;
    const found =
      run(
        `select 1 from sqlite_master where type = 'table' and name = ?`,
        table
      ).length > 0;
    if (found) ensure();
    else state = "absent";
    return found;
  };
  return {
    add(record) {
      ensure();
      const messages = JSON.stringify(record.messages);
      const split = messages.length > HELD_MESSAGES_PIECE;
      let count = 0;
      if (split) {
        withPieces.add(record.requestId);
        run(`delete from ${pieces} where request_id = ?`, record.requestId);
        for (let at = 0; at < messages.length; at += HELD_MESSAGES_PIECE) {
          run(
            `insert into ${pieces} (request_id, piece, data) values (?, ?, ?)`,
            record.requestId,
            count++,
            messages.slice(at, at + HELD_MESSAGES_PIECE)
          );
        }
      }
      run(
        `insert or replace into ${table}
           (request_id, seq, message_ids, decision, payload, stopped,
            created_at, messages, message_pieces, after_user_id)
         select ?, coalesce(max(seq), 0) + 1, ?, ?, ?, 0, ?, ?, ?, ?
         from ${table}`,
        record.requestId,
        JSON.stringify(record.messages.map((message) => message.id)),
        JSON.stringify(record.decision),
        record.payload === undefined ? null : JSON.stringify(record.payload),
        Date.now(),
        split ? null : messages,
        count,
        record.afterUserId
      );
    },
    remove(requestId) {
      if (!exists()) return;
      run(`delete from ${table} where request_id = ?`, requestId);
      if (withPieces.delete(requestId)) {
        run(`delete from ${pieces} where request_id = ?`, requestId);
      }
    },
    stop(requestId) {
      if (!exists()) return;
      run(`update ${table} set stopped = 1 where request_id = ?`, requestId);
    },
    stopAll() {
      if (!exists()) return;
      run(`update ${table} set stopped = 1`);
    },
    clear() {
      if (!exists()) return;
      run(`delete from ${table}`);
      run(`delete from ${pieces}`);
      withPieces.clear();
    },
    list() {
      if (!exists()) return [];
      return run(
        `select request_id, seq, message_ids, decision, payload, stopped,
                created_at, messages, message_pieces, after_user_id
         from ${table} order by seq`
      ).map((row) => ({
        requestId: String(row.request_id),
        seq: Number(row.seq),
        messageIds: parseJson<string[]>(row.message_ids) ?? [],
        messages: heldMessages(
          Number(row.message_pieces) > 0 &&
            withPieces.add(String(row.request_id))
            ? run(
                `select data from ${pieces} where request_id = ?
                 order by piece`,
                row.request_id
              )
                .map((piece) => String(piece.data))
                .join("")
            : row.messages
        ),
        afterUserId:
          typeof row.after_user_id === "string" ? row.after_user_id : null,
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

function heldMessages(value: unknown): HeldChatMessage[] {
  const parsed = parseJson<unknown>(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (message): message is HeldChatMessage =>
      typeof message === "object" &&
      message !== null &&
      typeof (message as HeldChatMessage).id === "string" &&
      typeof (message as HeldChatMessage).role === "string"
  );
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
  // Requests recovery has an incident for. Their turn's run can still be
  // settling after the incident did; it no longer waits for recovery.
  const named = new Set<string>();
  const incidents = await input.storage.list<{
    status?: string;
    requestId?: string;
    recoveryRootRequestId?: string;
  }>({ prefix: "cf:chat-recovery:incident:" });
  for (const incident of incidents.values()) {
    if (!incident) continue;
    if (incident.requestId) named.add(incident.requestId);
    if (incident.recoveryRootRequestId) {
      named.add(incident.recoveryRootRequestId);
    }
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
      requestId === undefined
        ? !input.liveRequestIds.has(id) && !named.has(id)
        : id === requestId
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
  /**
   * Records were dropped before their messages joined the transcript (too
   * old to replay): tabs that draw those messages as waiting must be told.
   */
  waitingDropped?(): void;
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

  /**
   * The records, as last read. Every write goes through this class, so the
   * copy stays current. `null` until the first read.
   */
  #records: ChatAdmissionRecord[] | null = null;

  #list(): ChatAdmissionRecord[] {
    this.#records ??= this.host.store.list();
    return this.#records;
  }

  /** Change the copy as the store was changed, if it was read. */
  #changed(
    change: (records: ChatAdmissionRecord[]) => ChatAdmissionRecord[]
  ): void {
    if (this.#records) this.#records = change(this.#records);
  }

  /** Record an accepted request. It holds its messages until its turn. */
  admit(record: {
    requestId: string;
    messages: HeldChatMessage[];
    afterUserId: string | null;
    decision: StoredSubmitDecision;
    payload: unknown;
  }): void {
    this.live.add(record.requestId);
    this.host.store.add(record);
    this.#changed((records) => [
      ...records.filter((r) => r.requestId !== record.requestId),
      {
        requestId: record.requestId,
        seq: (records.at(-1)?.seq ?? 0) + 1,
        messageIds: record.messages.map((message) => message.id),
        messages: record.messages,
        afterUserId: record.afterUserId,
        decision: record.decision,
        payload: record.payload,
        stopped: false,
        createdAt: Date.now()
      }
    ]);
  }

  /** The request's turn has a fiber, or the request ended without one. */
  release(requestId: string): void {
    this.host.store.remove(requestId);
    this.#changed((records) =>
      records.filter((r) => r.requestId !== requestId)
    );
  }

  /** The process that owned the request ended. */
  end(requestId: string): void {
    this.live.delete(requestId);
    this.release(requestId);
  }

  stop(requestId: string): void {
    this.host.store.stop(requestId);
    this.#changed((records) =>
      records.map((r) =>
        r.requestId === requestId ? { ...r, stopped: true } : r
      )
    );
  }

  stopAll(): void {
    this.host.store.stopAll();
    this.#changed((records) => records.map((r) => ({ ...r, stopped: true })));
  }

  /** A clear: every record goes. */
  clear(): void {
    this.host.store.clear();
    this.#records = [];
    this.#orphansMaybe = false;
  }

  /** The record of a request, if it has one. */
  record(requestId: string): ChatAdmissionRecord | undefined {
    return this.#list().find((r) => r.requestId === requestId);
  }

  /**
   * The messages requests hold that have not joined the transcript yet, in
   * admission order: what a tab draws after the transcript, marked as
   * queued. A message already stored (its turn has started) is left out.
   *
   * @param stored - The ids of the stored messages.
   */
  waitingMessages(stored: ReadonlySet<string>): HeldChatMessage[] {
    const records = this.#list();
    if (records.length === 0) return [];
    const seen = new Set<string>();
    const waiting: HeldChatMessage[] = [];
    for (const record of records) {
      for (const message of record.messages) {
        if (stored.has(message.id) || seen.has(message.id)) continue;
        seen.add(message.id);
        waiting.push(message);
      }
    }
    return waiting;
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
    return this.#list().filter((r) => !this.live.has(r.requestId));
  }

  async #replay(): Promise<void> {
    const records: ChatAdmissionRecord[] = [];
    let expired = false;
    for (const record of this.#orphans()) {
      const old = Date.now() - record.createdAt > CHAT_ADMISSION_TTL_MS;
      if (old || (await this.host.recoveryOwns(record.requestId))) {
        this.release(record.requestId);
        if (old) expired = true;
        continue;
      }
      records.push(record);
    }
    if (expired) this.host.waitingDropped?.();
    const replays = records.filter(
      (record) => !this.live.has(record.requestId)
    );
    for (const record of replays) this.live.add(record.requestId);
    this.host.beginReplay(replays);
    for (const listed of replays) {
      // Read again: a stop or a clear can have landed while this pass
      // awaited, and the request has no abort controller yet to take it.
      const record = this.record(listed.requestId);
      if (!record) {
        this.live.delete(listed.requestId);
        continue;
      }
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
