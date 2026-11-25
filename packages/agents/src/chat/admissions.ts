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
 *   accepted after: a rollback answered something newer) ends `skipped`,
 *   with its messages stored after what is there. Only a clear discards a
 *   waiting message, and a record is replayed however old it is.
 *
 * The store is the host's, behind {@link ChatAdmissionStore}. An object
 * written by an older release has no records, and an older release never
 * reads the table.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { Tasks } from "../tasks";
import { CHAT_TURN_LANE } from "./turn-task";
import type { AgentToolSql } from "./agent-tool-run-store";
import type { NormalizedMessageConcurrency } from "./submit-concurrency";

/**
 * The new user messages a client request holds until its turn starts: the
 * user messages at the end of what it sent that are not stored yet. A
 * client sends its whole transcript, and with windowed history `stored`
 * holds only the newest messages, so an older message outside the window
 * is not new: only the run after the last stored message counts. The run
 * ends at a message that is not a user's (a reply the tab drew while it
 * streamed): that one, and what comes before it, is stored with the
 * request, as before, so the held messages always go last.
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
    if (stored.has(messages[i].id) || messages[i].role !== "user") break;
    ids.unshift(messages[i].id);
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

/** The table an earlier release kept admission records in. */
export const CHAT_ADMISSIONS_TABLE = "cf_agents_chat_admissions";

/**
 * Read the admission records an earlier release left, in admission order.
 * `drop()` deletes their tables, once their replacements are written: the
 * records now live on the chat lane's runs. An object with no table pays
 * one read of no rows.
 */
export function takeReleasedChatAdmissions(sql: () => AgentToolSql): {
  records: ChatAdmissionRecord[];
  drop(): void;
} {
  const table = CHAT_ADMISSIONS_TABLE;
  const pieces = `${table}_messages`;
  const run = (query: string, ...bindings: unknown[]) =>
    sql()
      .exec(query, ...bindings)
      .toArray();
  try {
    run(`select 1 from ${table} limit 0`);
  } catch (error) {
    if (!String(error).includes("no such table")) throw error;
    return { records: [], drop: () => {} };
  }
  const columns = new Set(
    run(`select name from pragma_table_info('${table}')`).map((row) =>
      String(row.name)
    )
  );
  const has = (name: string) => columns.has(name);
  const records = run(
    `select request_id, seq, message_ids, decision, payload, stopped,
            created_at,
            ${has("messages") ? "messages" : "null as messages"},
            ${has("message_pieces") ? "message_pieces" : "0 as message_pieces"},
            ${has("after_user_id") ? "after_user_id" : "null as after_user_id"}
     from ${table} order by seq`
  ).map((row): ChatAdmissionRecord => {
    const requestId = String(row.request_id);
    let messages: unknown = row.messages;
    let payload: unknown = parseJson<unknown>(row.payload);
    if (Number(row.message_pieces) > 0) {
      const joined = parseJson<unknown>(
        run(
          `select data from ${pieces} where request_id = ? order by piece`,
          requestId
        )
          .map((piece) => String(piece.data))
          .join("")
      );
      if (Array.isArray(joined)) {
        messages = joined;
      } else if (joined && typeof joined === "object") {
        const both = joined as { messages?: unknown; payload?: unknown };
        messages = both.messages;
        payload = both.payload ?? undefined;
      }
    }
    return {
      requestId,
      seq: Number(row.seq),
      messageIds: parseJson<string[]>(row.message_ids) ?? [],
      messages: heldMessages(
        typeof messages === "string" ? messages : JSON.stringify(messages)
      ),
      afterUserId:
        typeof row.after_user_id === "string" ? row.after_user_id : null,
      decision: parseJson<StoredSubmitDecision>(row.decision) ?? {
        strategy: null,
        overlapping: false,
        debounceUntilMs: null
      },
      payload,
      stopped: Number(row.stopped) === 1,
      createdAt: Number(row.created_at)
    };
  });
  return {
    records,
    drop: () => {
      run(`drop table if exists ${pieces}`);
      run(`drop table if exists ${table}`);
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
 * turn definition (a turn queued on the chat lane once its model call
 * began), and legacy fibers (facets). A table that does not exist
 * yet holds none.
 */
export function interruptedTurnRequestIds(
  sql: AgentToolSql,
  turnName: string
): string[] {
  const ids: string[] = [];
  try {
    for (const row of sql
      .exec(
        `select input, metadata from cf_agents_task_runs
         where definition = ? and status in ('pending', 'running')
           and (lane is null or json_type(checkpoint, '$.snapshot') is not null)`,
        turnName
      )
      .toArray()) {
      // The run's metadata names its request. Its input does too, but a
      // large input is kept in parts, not on the row; runs from before the
      // metadata named it have only the input.
      const requestId =
        parseJson<{ requestId?: unknown }>(row.metadata)?.requestId ??
        parseJson<{ requestId?: unknown }>(row.input)?.requestId;
      if (typeof requestId === "string") ids.push(requestId);
    }
  } catch {
    // No Tasks table yet.
  }
  try {
    const prefix = `${turnName}:`;
    for (const row of sql
      .exec(
        `select json_extract(input, '$.name') as name from cf_agents_task_runs
         where definition = '__cf_fiber' and status in ('pending', 'running')
           and substr(json_extract(input, '$.name'), 1, ?) = ?`,
        prefix.length,
        prefix
      )
      .toArray()) {
      ids.push(String(row.name).slice(prefix.length));
    }
  } catch {
    // No Tasks table yet.
  }
  return ids;
}

/** What a client request's run holds until its turn starts. JSON. */
export interface ChatAdmissionInput {
  /**
   * Admission order: increasing across the requests of one object (runs
   * accepted in the same millisecond list in no set order).
   */
  order?: number;
  messages: HeldChatMessage[];
  afterUserId: string | null;
  decision: StoredSubmitDecision;
  payload: unknown;
}

/** Where a continuation's record is kept until its turn starts. */
export const CHAT_CONTINUATION_KEY_PREFIX = "cf:chat:continuation:";

/** What {@link ChatAdmissions} needs from the host. */
export interface ChatAdmissionsHost {
  /** The chat lane's runs: the client requests that wait. */
  tasks(): Pick<Tasks, "peekList" | "inputOf" | "patchMetadata">;
  /** The chat-turn definition the lane's runs are of. */
  definition: string;
  /** Where continuations' records are kept. */
  storage(): Pick<DurableObjectStorage, "put" | "delete" | "list">;
}

/**
 * The requests accepted and not started yet. A client request's record is
 * its run on the chat lane (its input holds the messages it waits with); a
 * continuation's is a storage key, since it takes no place in the lane
 * until it fires (it can wait long, for a sibling's answer).
 *
 * In memory: one entry per waiting request of this isolate (and those an
 * earlier isolate left, read once), removed when its turn starts or it ends.
 */
export class ChatAdmissions {
  /** Waiting client requests: their run and the messages they hold. */
  readonly #held = new Map<
    string,
    { runId: string | null; messages: HeldChatMessage[] }
  >();
  /** Stops of requests no run was known for, by request id. */
  readonly #stoppedUnseen = new Set<string>();
  /** Continuations with a record. */
  readonly #continuations = new Set<string>();
  #seeded = false;
  #continuationsRead = false;

  constructor(private readonly host: ChatAdmissionsHost) {}

  /**
   * The decisions of the runs an earlier isolate left waiting, in lane
   * order, once: nothing after the first call.
   */
  takeSeeded(): Array<{ requestId: string; decision: StoredSubmitDecision }> {
    this.#seed();
    return this.#seededDecisions.splice(0);
  }

  readonly #seededDecisions: Array<{
    requestId: string;
    decision: StoredSubmitDecision;
  }> = [];

  /** Read, once, the runs an earlier isolate left waiting. */
  #seed(): void {
    if (this.#seeded) return;
    const tasks = this.host.tasks();
    let runs: ReturnType<typeof tasks.peekList>;
    try {
      runs = tasks.peekList({
        definition: this.host.definition,
        lane: CHAT_TURN_LANE,
        status: ["pending", "running"],
        results: false,
        order: "oldest"
      });
    } catch {
      // Tasks has not started: read them on a later call.
      return;
    }
    this.#seeded = true;
    const found: Array<{
      requestId: string;
      runId: string;
      admission: ChatAdmissionInput;
    }> = [];
    for (const run of runs) {
      const requestId = run.metadata?.requestId;
      if (typeof requestId !== "string" || this.#held.has(requestId)) continue;
      const admission = tasks.inputOf<{ admission?: ChatAdmissionInput }>(
        run.runId
      )?.admission;
      if (!admission) continue;
      found.push({ requestId, runId: run.runId, admission });
    }
    found.sort((a, b) => (a.admission.order ?? 0) - (b.admission.order ?? 0));
    for (const { requestId, runId, admission } of found) {
      this.#held.set(requestId, { runId, messages: admission.messages });
      this.#seededDecisions.push({ requestId, decision: admission.decision });
    }
  }

  /**
   * A client request waits in the lane, holding `messages`: as `runId` once
   * its run is accepted (`null` until then).
   */
  hold(
    requestId: string,
    runId: string | null,
    messages: HeldChatMessage[]
  ): void {
    this.#held.set(requestId, { runId, messages });
    if (runId !== null && this.#stoppedUnseen.delete(requestId)) {
      this.#mark(runId, { stopped: true });
    }
  }

  /**
   * Keep a continuation's record until its turn starts. `carried`: one an
   * earlier release kept, which {@link continuations} hands back to
   * schedule.
   */
  async admitContinuation(
    requestId: string,
    targetMessageIds: string[],
    carried = false
  ): Promise<void> {
    if (!carried) this.#continuations.add(requestId);
    await this.host
      .storage()
      .put(CHAT_CONTINUATION_KEY_PREFIX + requestId, { targetMessageIds });
  }

  /** The continuations an earlier isolate left, in the order they were kept. */
  async continuations(): Promise<
    Array<{ requestId: string; targetMessageIds: string[] }>
  > {
    // Read once per isolate: this isolate's own are known without a read.
    if (this.#continuationsRead) return [];
    this.#continuationsRead = true;
    const kept = await this.host
      .storage()
      .list<{ targetMessageIds?: unknown }>({
        prefix: CHAT_CONTINUATION_KEY_PREFIX
      });
    const out: Array<{ requestId: string; targetMessageIds: string[] }> = [];
    for (const [key, value] of kept) {
      const requestId = key.slice(CHAT_CONTINUATION_KEY_PREFIX.length);
      if (this.#continuations.has(requestId)) continue;
      const ids = Array.isArray(value?.targetMessageIds)
        ? value.targetMessageIds.filter(
            (id): id is string => typeof id === "string"
          )
        : [];
      this.#continuations.add(requestId);
      out.push({ requestId, targetMessageIds: ids });
    }
    return out;
  }

  /** Read the continuations `requestIds` again on the next call. */
  forgetRead(requestIds: string[]): void {
    this.#continuationsRead = false;
    for (const requestId of requestIds) this.#continuations.delete(requestId);
  }

  /** A request's turn started, or it ended: it waits no more. */
  end(requestId: string): void {
    this.#held.delete(requestId);
    if (this.#continuations.delete(requestId)) {
      void this.host
        .storage()
        .delete(CHAT_CONTINUATION_KEY_PREFIX + requestId)
        .catch((error: unknown) =>
          console.error("[chat] a continuation record was not removed:", error)
        );
    }
  }

  /** A stop by the request id, kept on its waiting run. */
  stop(requestId: string): void {
    this.#seed();
    const held = this.#held.get(requestId);
    if (held?.runId) this.#mark(held.runId, { stopped: true });
    // Not known here yet (the lane's runs are read before Tasks started, or
    // the request's run is accepted later): its replay asks.
    else {
      this.#stoppedUnseen.add(requestId);
      // Bounded: most are stops of requests that already ended.
      if (this.#stoppedUnseen.size > 64) {
        const [oldest] = this.#stoppedUnseen;
        this.#stoppedUnseen.delete(oldest);
      }
    }
  }

  /** Whether a stop landed for `requestId` before its run was known. */
  takeStop(requestId: string): boolean {
    return this.#stoppedUnseen.delete(requestId);
  }

  /** Stop every waiting request. */
  stopAll(): void {
    this.#seed();
    for (const [requestId, held] of this.#held) {
      if (held.runId) this.#mark(held.runId, { stopped: true });
      else this.#stoppedUnseen.add(requestId);
    }
  }

  /** A clear: no waiting request runs, and its messages are discarded. */
  clear(): void {
    this.#seed();
    for (const held of this.#held.values()) {
      if (held.runId) this.#mark(held.runId, { cleared: true });
    }
    this.#held.clear();
    for (const requestId of [...this.#continuations]) this.end(requestId);
  }

  #mark(runId: string, flag: Record<string, boolean>): void {
    this.host.tasks().patchMetadata(runId, "chat", flag);
  }

  /**
   * The messages waiting requests hold that are not in `stored`, in
   * admission order. Tabs draw them after the transcript.
   */
  waitingMessages(stored: ReadonlySet<string>): HeldChatMessage[] {
    this.#seed();
    if (this.#held.size === 0) return [];
    const seen = new Set<string>();
    const waiting: HeldChatMessage[] = [];
    for (const { messages } of this.#held.values()) {
      for (const message of messages) {
        if (stored.has(message.id) || seen.has(message.id)) continue;
        seen.add(message.id);
        waiting.push(message);
      }
    }
    return waiting;
  }
}
