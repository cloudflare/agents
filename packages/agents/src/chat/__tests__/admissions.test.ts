import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MemoryWorld, memoryLane, memoryStorage } from "./memory-lane";
import { describe, expect, it } from "vitest";
import {
  chatRecoveryNames,
  newUserMessageIds,
  takeReleasedChatAdmissions,
  type ChatAdmissionRecord
} from "../admissions";
import {
  ChatTurns,
  type ChatTurnMessage,
  type ChatTurnsHost,
  type ClientChatRequest
} from "../chat-turns";
import type { MessageConcurrency } from "../lifecycle";

/** A host reduced to a transcript. */
class Host implements ChatTurnsHost {
  transcript: ChatTurnMessage[] = [];
  messages() {
    return this.transcript;
  }
  isReplyStreaming() {
    return false;
  }
  streamingReply() {
    return null;
  }
  clientToolNames() {
    return new Set<string>();
  }
  hasActiveStream() {
    return false;
  }
  generateRequestId() {
    return crypto.randomUUID();
  }
  /** Keep-alive holds taken: each one is a job pushed and deleted. */
  holds = 0;
  keepAliveWhile<T>(fn: () => Promise<T>) {
    this.holds++;
    return fn();
  }
  fireContinuation() {}
}

type Ended = "ran" | "skipped" | "aborted";

/**
 * One isolate's turn core over one object's chat lane: build a second one
 * over the same `world` and the first one's memory is gone, as after a
 * reset. What the lane holds (its runs, their inputs and marks) is kept.
 */
function isolate(
  world: MemoryWorld,
  options: {
    concurrency?: MessageConcurrency;
    /** `false`: a turn's model call never begins, so its run stays a record. */
    fiber?: boolean;
    /** Awaited in a request's `persist`: what lands while it waits. */
    duringPersist?: (requestId: string) => Promise<void>;
  } = {}
) {
  const lane = memoryLane(world);
  const host = new Host();
  const ended = new Map<string, Ended>();
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const replayed: ChatAdmissionRecord[] = [];
  const joins: string[] = [];
  /** The transcript each turn started with: what its model request holds. */
  const asked = new Map<string, string[]>();

  const request = (requestId: string): ClientChatRequest<true> => ({
    requestId,
    isSubmitMessage: true,
    concurrency: options.concurrency ?? "queue",
    admission: {
      messages: [{ id: `u-${requestId}`, role: "user" }],
      payload: { requestId }
    },
    onDropped: () => ended.set(requestId, "skipped"),
    persist: async () => {
      await options.duringPersist?.(requestId);
      return true;
    },
    join: async ({ messages }) => {
      joins.push(...messages.map((m) => m.id));
      for (const message of messages) {
        host.transcript.push({ ...message, parts: [] });
      }
      return true;
    },
    enqueue: async (turn, generation, onQueued) => {
      const done = turns.queue.enqueue(requestId, turn, { generation });
      onQueued();
      const result = await done;
      return result.status === "stale" ? "stale" : "completed";
    },
    run: async () => {
      started.push(requestId);
      asked.set(
        requestId,
        host.transcript.map((m) => m.id)
      );
      // The turn's model call begins: its run is recovery's from now on.
      if (options.fiber !== false) {
        world.began.add(requestId);
        turns.turnAccepted(requestId);
      }
      await new Promise<void>((resolve) => gates.set(requestId, resolve));
      ended.set(requestId, "ran");
    },
    onSkipped: () => ended.set(requestId, "skipped"),
    onCancelledBeforeStart: () => ended.set(requestId, "aborted")
  });

  const turns: ChatTurns = new ChatTurns(host, {
    defaultDebounceMs: 0,
    lane,
    admissions: {
      storage: memoryStorage(world.keys).storage,
      recoveryPending: async () => false,
      released: () => ({ records: [], drop: () => {} }),
      replayRequest: (record) => {
        replayed.push(record);
        return request(record.requestId);
      }
    }
  });

  return {
    turns,
    host,
    ended,
    started,
    replayed,
    joins,
    asked,
    ids: () => host.transcript.map((m) => m.id),
    /** The requests waiting on the lane, not cleared. */
    records: () => world.waiting(),
    send: (requestId: string) => turns.runClientRequest(request(requestId)),
    finish: (requestId: string) => gates.get(requestId)?.(),
    /** This isolate's start: what earlier isolates left runs, in lane order. */
    resume: async () => {
      // The wake runs them; it settles when they do, so it is not awaited.
      void lane.wake(turns);
      await turns.resumeAdmissions();
      await tick();
    },
    copyTranscript: (from: { host: Host }) => {
      host.transcript = [...from.host.transcript];
    }
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Long enough for a replay in the lane to settle and the next to start. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await tick();
};

/** r1 runs, then `queued` wait behind it; the isolate then "resets". */
async function queueBehindRunningTurn(db: MemoryWorld, queued: string[]) {
  const first = isolate(db);
  void first.send("r1");
  await tick();
  for (const id of queued) void first.send(id);
  await tick();
  return first;
}

describe("durable admission", () => {
  it("records a request until its turn has a fiber, and not after it ends", async () => {
    const db = new MemoryWorld();
    const a = isolate(db);
    const r1 = a.send("r1");
    await tick();
    expect(a.records()).toEqual([]);
    void a.send("r2");
    await tick();
    expect(a.records()).toEqual(["r2"]);
    a.finish("r1");
    await r1;
    await tick();
    expect(a.records()).toEqual([]);
    expect(a.started).toEqual(["r1", "r2"]);
  });

  it("takes no keep-alive hold on a start with nothing to replay", async () => {
    const db = new MemoryWorld();
    const a = isolate(db);
    const before = a.host.holds;
    await a.resume();
    expect(a.host.holds).toBe(before);
  });

  it("replays what a reset left, in order, each as its own request", async () => {
    const db = new MemoryWorld();
    const a = await queueBehindRunningTurn(db, ["r2", "r3"]);
    expect(a.records()).toEqual(["r2", "r3"]);

    const b = isolate(db);
    b.copyTranscript(a);
    await b.resume();
    await tick();
    expect(b.started).toEqual(["r2"]);
    b.finish("r2");
    await flush();
    expect(b.started).toEqual(["r2", "r3"]);
    b.finish("r3");
    await tick();
    expect(b.records()).toEqual([]);
  });

  it("a new request waits behind what a reset left, in lane order", async () => {
    const db = new MemoryWorld();
    const a = await queueBehindRunningTurn(db, ["r2"]);
    const b = isolate(db);
    b.copyTranscript(a);
    void b.send("r9");
    await tick();
    // r1's run (recovery's) and r2's are ahead of it in the lane.
    expect(b.started).toEqual([]);
    await b.resume();
    await tick();
    expect(b.started).toEqual(["r2"]);
    b.finish("r2");
    await tick();
    await tick();
    expect(b.started).toEqual(["r2", "r9"]);
  });
  it("a stop while the request is only a record ends it aborted after the reset", async () => {
    const db = new MemoryWorld();
    const a = await queueBehindRunningTurn(db, ["r2"]);
    const b = isolate(db);
    b.copyTranscript(a);
    await b.turns.cancel("r2");
    const c = isolate(db);
    c.copyTranscript(a);
    await c.resume();
    await tick();
    expect(c.started).toEqual([]);
    expect(c.ended.get("r2")).toBe("aborted");
    expect(c.records()).toEqual([]);
  });

  it("a stop of a queued request is on its record, so a reset does not undo it", async () => {
    const db = new MemoryWorld();
    const a = await queueBehindRunningTurn(db, ["r2"]);
    await a.turns.cancel("r2");
    const b = isolate(db);
    b.copyTranscript(a);
    await b.resume();
    await tick();
    expect(b.started).toEqual([]);
    expect(b.ended.get("r2")).toBe("aborted");
  });

  it("a clear deletes every record", async () => {
    const db = new MemoryWorld();
    const a = await queueBehindRunningTurn(db, ["r2"]);
    a.turns.reset();
    expect(a.records()).toEqual([]);
  });

  it("a replay stores the message its record holds, after the transcript", async () => {
    const db = new MemoryWorld();
    const a = await queueBehindRunningTurn(db, ["r2"]);
    // The waiting message is on the record only.
    expect(a.ids()).toEqual(["u-r1"]);
    const b = isolate(db);
    b.copyTranscript(a);
    b.host.transcript.push({ id: "a-r1", role: "assistant", parts: [] });
    await b.resume();
    await tick();
    expect(b.started).toEqual(["r2"]);
    expect(b.asked.get("r2")).toEqual(["u-r1", "a-r1", "u-r2"]);
  });

  it("a reset after the message joined does not store it again", async () => {
    const db = new MemoryWorld();
    const a = isolate(db, { fiber: false });
    void a.send("r1");
    await tick();
    void a.send("r2");
    await tick();
    a.finish("r1");
    await tick();
    await tick();
    // r2 joined and started, and its fiber was never accepted.
    expect(a.started).toEqual(["r1", "r2"]);
    expect(a.records()).toEqual(["r2"]);
    const b = isolate(db);
    b.copyTranscript(a);
    await b.resume();
    await tick();
    expect(b.started).toEqual(["r2"]);
    expect(b.joins).toEqual([]);
    expect(b.ids()).toEqual(["u-r1", "u-r2"]);
  });

  it("under `latest`, a request a later one superseded stays superseded", async () => {
    const db = new MemoryWorld();
    const first = isolate(db, { concurrency: "latest" });
    void first.send("r1");
    await tick();
    void first.send("r2");
    void first.send("r3");
    await tick();
    const b = isolate(db, { concurrency: "latest" });
    b.copyTranscript(first);
    await b.resume();
    await flush();
    expect(b.ended.get("r2")).toBe("skipped");
    expect(b.started).toEqual(["r3"]);
    // The superseded question is kept, before the one that superseded it.
    expect(b.asked.get("r3")).toEqual(["u-r1", "u-r2", "u-r3"]);
  });

  it("tabs are sent a waiting message after the transcript, named as queued", async () => {
    const db = new MemoryWorld();
    const a = await queueBehindRunningTurn(db, ["r2"]);
    const view = a.turns.clientView(a.host.transcript);
    expect(view.messages.map((m) => m.id)).toEqual(["u-r1", "u-r2"]);
    expect(view.queuedMessageIds).toEqual(["u-r2"]);
    // After a reset, before the replay, too.
    const b = isolate(db);
    b.copyTranscript(a);
    expect(b.turns.clientView(b.host.transcript).queuedMessageIds).toEqual([
      "u-r2"
    ]);
    a.finish("r1");
    await tick();
    await tick();
    // Joined: drawn once, not queued.
    const after = a.turns.clientView(a.host.transcript);
    expect(after.messages.map((m) => m.id)).toEqual(["u-r1", "u-r2"]);
    expect(after.queuedMessageIds).toBeUndefined();
  });

  it("a running turn's request never holds the question queued behind it", async () => {
    const db = new MemoryWorld();
    const a = await queueBehindRunningTurn(db, ["r2", "r3"]);
    expect(a.asked.get("r1")).toEqual(["u-r1"]);
    a.host.transcript.push({ id: "a-r1", role: "assistant", parts: [] });
    a.finish("r1");
    await tick();
    await tick();
    expect(a.asked.get("r2")).toEqual(["u-r1", "a-r1", "u-r2"]);
    a.host.transcript.push({ id: "a-r2", role: "assistant", parts: [] });
    a.finish("r2");
    await tick();
    await tick();
    expect(a.asked.get("r3")).toEqual(["u-r1", "a-r1", "u-r2", "a-r2", "u-r3"]);
  });

  it("a request stopped while it waits keeps its question, unanswered", async () => {
    const db = new MemoryWorld();
    const a = await queueBehindRunningTurn(db, ["r2", "r3"]);
    await a.turns.cancel("r2");
    a.finish("r1");
    await tick();
    await tick();
    expect(a.ended.get("r2")).toBe("aborted");
    expect(a.asked.get("r3")).toEqual(["u-r1", "u-r2", "u-r3"]);
  });

  it("a clear drops a waiting message: it is never stored", async () => {
    const db = new MemoryWorld();
    const a = await queueBehindRunningTurn(db, ["r2"]);
    a.turns.reset();
    a.host.transcript = [];
    a.finish("r1");
    await tick();
    await tick();
    expect(a.joins).toEqual(["u-r1"]);
    expect(a.turns.clientView(a.host.transcript).messages).toEqual([]);
  });

  it("a request whose record cannot be written ends with an error", async () => {
    const lane = memoryLane();
    const tasks = lane.tasks();
    const turns = new ChatTurns(new Host(), {
      defaultDebounceMs: 0,
      lane: {
        definition: lane.definition,
        tasks: () => ({
          ...tasks,
          run: async () => {
            throw new Error("SQLITE_TOOBIG");
          }
        })
      },
      admissions: {
        storage: memoryStorage().storage,
        recoveryPending: async () => false,
        released: () => ({ records: [], drop: () => {} }),
        replayRequest: () => null
      }
    });
    const errors: string[] = [];
    let persisted = false;
    await turns.runClientRequest({
      requestId: "r1",
      isSubmitMessage: true,
      concurrency: "queue",
      admission: { messages: [{ id: "u1", role: "user" }], payload: null },
      onDropped: () => {},
      persist: async () => {
        persisted = true;
        return true;
      },
      join: async () => true,
      enqueue: async () => "completed",
      run: async () => {},
      onSkipped: () => {},
      onCancelledBeforeStart: () => {},
      onError: (error, stage) => {
        errors.push(`${stage}:${String(error)}`);
      }
    });
    expect(errors).toEqual(["persist:Error: SQLITE_TOOBIG"]);
    expect(persisted).toBe(false);
  });

  it("replays a record however long its request waited", async () => {
    const db = new MemoryWorld();
    const a = await queueBehindRunningTurn(db, ["r2"]);
    // The turn ahead of it ran for two hours (a long agent-tool run): the
    // run keeps no deadline while it waits.
    const b = isolate(db);
    b.copyTranscript(a);
    await b.resume();
    await tick();
    expect(b.started).toEqual(["r2"]);
    expect(b.ids()).toContain("u-r2");
  });

  it("a replay whose conversation moved on stores its question and ends skipped", async () => {
    const db = new MemoryWorld();
    const a = await queueBehindRunningTurn(db, ["r2"]);
    const b = isolate(db);
    b.copyTranscript(a);
    // A release without durable admission ran meanwhile (a rollback) and
    // answered a newer question.
    b.host.transcript.push(
      { id: "a-r1", role: "assistant", parts: [] },
      { id: "u-new", role: "user", parts: [] },
      { id: "a-new", role: "assistant", parts: [] }
    );
    await b.resume();
    await tick();
    expect(b.started).toEqual([]);
    expect(b.ended.get("r2")).toBe("skipped");
    // Not lost: stored after what is there, unanswered.
    expect(b.ids().at(-1)).toBe("u-r2");
    expect(b.records()).toEqual([]);
  });

  it("a stop that lands while the replay awaits still stops the request", async () => {
    const db = new MemoryWorld();
    const a = await queueBehindRunningTurn(db, ["r2"]);
    const holder: { b?: ReturnType<typeof isolate> } = {};
    const b = isolate(db, {
      duringPersist: async (id) => {
        await holder.b?.turns.cancel(id);
      }
    });
    holder.b = b;
    b.copyTranscript(a);
    await b.resume();
    await tick();
    expect(b.started).toEqual([]);
    expect(b.ended.get("r2")).toBe("aborted");
  });

  it("a clear that lands while the replay awaits leaves nothing to replay", async () => {
    const db = new MemoryWorld();
    const a = await queueBehindRunningTurn(db, ["r2"]);
    const holder: { b?: ReturnType<typeof isolate> } = {};
    const b = isolate(db, {
      duringPersist: async () => {
        holder.b?.turns.reset();
      }
    });
    holder.b = b;
    b.copyTranscript(a);
    await b.resume();
    await tick();
    expect(b.started).toEqual([]);
    expect(b.ended.get("r2")).toBe("skipped");
  });
});

describe("chatRecoveryNames", () => {
  function setup(
    incidents: Array<Record<string, unknown>>,
    options: { partedRun?: boolean } = {}
  ) {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "create table cf_agents_task_runs (definition text, status text, input text, metadata text, lane text, checkpoint text)"
    );
    db.prepare(
      "insert into cf_agents_task_runs (definition, status, input, metadata) values (?, ?, ?, ?)"
    ).run("turn", "running", JSON.stringify({ requestId: "r1" }), null);
    if (options.partedRun) {
      // A run whose large input is kept in parts: only its metadata names it.
      db.prepare(
        "insert into cf_agents_task_runs (definition, status, input, metadata) values (?, ?, ?, ?)"
      ).run("turn", "pending", null, JSON.stringify({ requestId: "r-big" }));
    }
    const sql = {
      exec: (query: string, ...bindings: unknown[]) => {
        const rows = db.prepare(query).all(...(bindings as SQLInputValue[]));
        return { toArray: () => rows as Record<string, unknown>[] };
      }
    };
    const storage = {
      list: async <T>() =>
        new Map(incidents.map((incident, i) => [`k${i}`, incident as T]))
    } as unknown as Pick<DurableObjectStorage, "list">;
    return { sql, storage };
  }

  it("knows a turn whose run keeps its input in parts by its metadata", async () => {
    const { sql, storage } = setup([], { partedRun: true });
    expect(
      await chatRecoveryNames({
        sql,
        storage,
        turnName: "turn",
        liveRequestIds: new Set(),
        requestId: "r-big"
      })
    ).toBe(true);
  });

  it("a turn's run that nothing has picked up waits for recovery", async () => {
    const { sql, storage } = setup([]);
    expect(
      await chatRecoveryNames({
        sql,
        storage,
        turnName: "turn",
        liveRequestIds: new Set()
      })
    ).toBe(true);
    expect(
      await chatRecoveryNames({
        sql,
        storage,
        turnName: "turn",
        liveRequestIds: new Set(["r1"])
      })
    ).toBe(false);
  });

  it("a turn's run still settling after recovery settled its incident does not", async () => {
    const { sql, storage } = setup([{ status: "skipped", requestId: "r1" }]);
    expect(
      await chatRecoveryNames({
        sql,
        storage,
        turnName: "turn",
        liveRequestIds: new Set()
      })
    ).toBe(false);
    expect(
      await chatRecoveryNames({
        sql,
        storage,
        turnName: "turn",
        liveRequestIds: new Set(),
        requestId: "r1"
      })
    ).toBe(true);
  });

  it("a live incident waits for recovery", async () => {
    const { sql, storage } = setup([{ status: "scheduled", requestId: "r0" }]);
    expect(
      await chatRecoveryNames({
        sql,
        storage,
        turnName: "turn",
        liveRequestIds: new Set(["r1"])
      })
    ).toBe(true);
  });
});

describe("takeReleasedChatAdmissions", () => {
  const sql = (db: DatabaseSync) => () => ({
    exec: (query: string, ...bindings: unknown[]) => {
      const rows = db.prepare(query).all(...(bindings as SQLInputValue[]));
      return { toArray: () => rows as Record<string, unknown>[] };
    }
  });

  it("reads an earlier release's records in order, pieces included, and drops the tables", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`create table cf_agents_chat_admissions (
      request_id text primary key, seq integer, message_ids text,
      messages text, decision text, payload text, stopped integer,
      created_at integer, message_pieces integer, after_user_id text)`);
    db.exec(
      "create table cf_agents_chat_admissions_messages (request_id text, piece integer, data text)"
    );
    const both = JSON.stringify({
      messages: [{ id: "u2", role: "user" }],
      payload: { big: "x".repeat(10) }
    });
    const insert = db.prepare(
      "insert into cf_agents_chat_admissions values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    insert.run("r2", 2, '["u2"]', null, null, null, 1, 2, 2, "u1");
    insert.run(
      "r1",
      1,
      '["u1"]',
      '[{"id":"u1","role":"user"}]',
      '{"strategy":"latest","overlapping":true,"debounceUntilMs":null}',
      '{"trigger":"submit-message"}',
      0,
      1,
      0,
      null
    );
    const piece = db.prepare(
      "insert into cf_agents_chat_admissions_messages values (?, ?, ?)"
    );
    piece.run("r2", 0, both.slice(0, 20));
    piece.run("r2", 1, both.slice(20));

    const released = takeReleasedChatAdmissions(sql(db));
    const { records } = released;
    expect(records.map((r) => r.requestId)).toEqual(["r1", "r2"]);
    expect(records[0]).toMatchObject({
      messages: [{ id: "u1", role: "user" }],
      decision: { strategy: "latest", overlapping: true },
      payload: { trigger: "submit-message" },
      stopped: false
    });
    expect(records[1]).toMatchObject({
      messages: [{ id: "u2", role: "user" }],
      payload: { big: "x".repeat(10) },
      stopped: true,
      afterUserId: "u1"
    });
    // The tables stay until the records are carried over, then go.
    expect(takeReleasedChatAdmissions(sql(db)).records).toHaveLength(2);
    released.drop();
    expect(takeReleasedChatAdmissions(sql(db)).records).toEqual([]);
  });

  it("reads nothing on an object with no table", () => {
    expect(
      takeReleasedChatAdmissions(sql(new DatabaseSync(":memory:"))).records
    ).toEqual([]);
  });
});

describe("newUserMessageIds", () => {
  const m = (id: string, role = "user") => ({ id, role });

  it("counts only the user messages after the last stored one", () => {
    // Windowed history holds only a1 and u2: u0 and u1 are stored, outside
    // the window. The request stores u3 alone.
    expect(
      newUserMessageIds(
        [
          m("u0"),
          m("a0", "assistant"),
          m("u1"),
          m("a1", "assistant"),
          m("u2"),
          m("u3")
        ],
        new Set(["a1", "u2"])
      )
    ).toEqual(["u3"]);
  });

  it("counts every trailing user message the request sent", () => {
    expect(
      newUserMessageIds(
        [m("a1", "assistant"), m("u2"), m("u3")],
        new Set(["a1"])
      )
    ).toEqual(["u2", "u3"]);
    expect(newUserMessageIds([m("u1")], new Set())).toEqual(["u1"]);
  });

  it("ends at a message that is not a user's, so what it holds goes last", () => {
    expect(
      newUserMessageIds([m("u1"), m("a1", "assistant")], new Set())
    ).toEqual([]);
    expect(
      newUserMessageIds(
        [m("u1"), m("a1", "assistant"), m("u2")],
        new Set(["u1"])
      )
    ).toEqual(["u2"]);
  });
});
