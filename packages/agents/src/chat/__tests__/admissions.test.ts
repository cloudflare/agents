import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  chatRecoveryNames,
  createChatAdmissionStore,
  newUserMessageIds,
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
  keepAliveWhile<T>(fn: () => Promise<T>) {
    return fn();
  }
  fireContinuation() {}
}

type Ended = "ran" | "skipped" | "aborted";

/**
 * One isolate's turn core over a shared database: build a second one over
 * the same `db` and the first one's memory is gone, as after a reset.
 */
function isolate(
  db: DatabaseSync,
  options: {
    concurrency?: MessageConcurrency;
    recoveryPending?: () => boolean;
    recoveryOwns?: (requestId: string) => boolean | Promise<boolean>;
    /** `false`: a turn's fiber is never accepted, so its record stays. */
    fiber?: boolean;
  } = {}
) {
  let statements = 0;
  const store = createChatAdmissionStore(() => ({
    exec: (query: string, ...bindings: unknown[]) => {
      statements++;
      const rows = db.prepare(query).all(...(bindings as SQLInputValue[]));
      return { toArray: () => rows as Record<string, unknown>[] };
    }
  }));
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
    persist: async () => true,
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
      // The turn's fiber is accepted.
      if (options.fiber !== false) turns.turnAccepted(requestId);
      await new Promise<void>((resolve) => gates.set(requestId, resolve));
      ended.set(requestId, "ran");
    },
    onSkipped: () => ended.set(requestId, "skipped"),
    onCancelledBeforeStart: () => ended.set(requestId, "aborted")
  });

  const turns: ChatTurns = new ChatTurns(host, {
    defaultDebounceMs: 0,
    admissions: {
      store,
      recoveryPending: async () => options.recoveryPending?.() ?? false,
      recoveryOwns: async (id) => (await options.recoveryOwns?.(id)) ?? false,
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
    statements: () => statements,
    records: () => store.list().map((r) => r.requestId),
    send: (requestId: string) => turns.runClientRequest(request(requestId)),
    finish: (requestId: string) => gates.get(requestId)?.(),
    copyTranscript: (from: { host: Host }) => {
      host.transcript = [...from.host.transcript];
    }
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** r1 runs, then `queued` wait behind it; the isolate then "resets". */
async function queueBehindRunningTurn(db: DatabaseSync, queued: string[]) {
  const first = isolate(db);
  void first.send("r1");
  await tick();
  for (const id of queued) void first.send(id);
  await tick();
  return first;
}

describe("durable admission", () => {
  it("records a request until its turn has a fiber, and not after it ends", async () => {
    const db = new DatabaseSync(":memory:");
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

  it("costs three statements and two written rows for a request that runs", async () => {
    const db = new DatabaseSync(":memory:");
    const a = isolate(db);
    void a.send("warm");
    await tick();
    a.finish("warm");
    await tick();
    const before = a.statements();
    const r = a.send("r1");
    await tick();
    a.finish("r1");
    await r;
    // insert at admission, delete at the fiber, delete (of nothing) at the end
    expect(a.statements() - before).toBe(3);
  });

  it("replays what a reset left, in order, each as its own request", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2", "r3"]);
    expect(a.records()).toEqual(["r2", "r3"]);

    const b = isolate(db);
    b.copyTranscript(a);
    await b.turns.resumeAdmissions();
    await tick();
    expect(b.started).toEqual(["r2"]);
    b.finish("r2");
    await tick();
    await tick();
    expect(b.started).toEqual(["r2", "r3"]);
    b.finish("r3");
    await tick();
    expect(b.records()).toEqual([]);
  });

  it("waits while an interrupted turn waits for recovery", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2"]);
    let pending = true;
    const b = isolate(db, { recoveryPending: () => pending });
    b.copyTranscript(a);
    await b.turns.resumeAdmissions();
    await tick();
    expect(b.started).toEqual([]);
    pending = false;
    await b.turns.resumeAdmissions();
    await tick();
    expect(b.started).toEqual(["r2"]);
  });

  it("a new request replays the records first, ahead of itself, recovery or not", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2"]);
    const b = isolate(db, { recoveryPending: () => true });
    b.copyTranscript(a);
    void b.send("r9");
    await tick();
    await tick();
    expect(b.started).toEqual(["r2"]);
    b.finish("r2");
    await tick();
    await tick();
    expect(b.started).toEqual(["r2", "r9"]);
  });

  it("a stop while the request is only a record ends it aborted after the reset", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2"]);
    const b = isolate(db, { recoveryPending: () => true });
    b.copyTranscript(a);
    await b.turns.cancel("r2");
    const c = isolate(db);
    c.copyTranscript(a);
    await c.turns.resumeAdmissions();
    await tick();
    expect(c.started).toEqual([]);
    expect(c.ended.get("r2")).toBe("aborted");
    expect(c.records()).toEqual([]);
  });

  it("a stop of a queued request is on its record, so a reset does not undo it", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2"]);
    await a.turns.cancel("r2");
    const b = isolate(db);
    b.copyTranscript(a);
    await b.turns.resumeAdmissions();
    await tick();
    expect(b.started).toEqual([]);
    expect(b.ended.get("r2")).toBe("aborted");
  });

  it("a clear deletes every record", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2"]);
    a.turns.reset();
    expect(a.records()).toEqual([]);
  });

  it("leaves a request recovery owns to recovery", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2"]);
    const b = isolate(db, { recoveryOwns: (id) => id === "r2" });
    b.copyTranscript(a);
    await b.turns.resumeAdmissions();
    await tick();
    expect(b.replayed).toEqual([]);
    expect(b.records()).toEqual([]);
  });

  it("a replay stores the message its record holds, after the transcript", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2"]);
    // The waiting message is on the record only.
    expect(a.ids()).toEqual(["u-r1"]);
    const b = isolate(db);
    b.copyTranscript(a);
    b.host.transcript.push({ id: "a-r1", role: "assistant", parts: [] });
    await b.turns.resumeAdmissions();
    await tick();
    expect(b.started).toEqual(["r2"]);
    expect(b.asked.get("r2")).toEqual(["u-r1", "a-r1", "u-r2"]);
  });

  it("a reset after the message joined does not store it again", async () => {
    const db = new DatabaseSync(":memory:");
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
    await b.turns.resumeAdmissions();
    await tick();
    expect(b.started).toEqual(["r2"]);
    expect(b.joins).toEqual([]);
    expect(b.ids()).toEqual(["u-r1", "u-r2"]);
  });

  it("under `latest`, a request a later one superseded stays superseded", async () => {
    const db = new DatabaseSync(":memory:");
    const first = isolate(db, { concurrency: "latest" });
    void first.send("r1");
    await tick();
    void first.send("r2");
    void first.send("r3");
    await tick();
    const b = isolate(db, { concurrency: "latest" });
    b.copyTranscript(first);
    await b.turns.resumeAdmissions();
    await tick();
    await tick();
    expect(b.ended.get("r2")).toBe("skipped");
    expect(b.started).toEqual(["r3"]);
    // The superseded question is kept, before the one that superseded it.
    expect(b.asked.get("r3")).toEqual(["u-r1", "u-r2", "u-r3"]);
  });

  it("under `latest`, a new request during recovery is not superseded by the older replays", async () => {
    const db = new DatabaseSync(":memory:");
    const first = isolate(db, { concurrency: "latest" });
    void first.send("r1");
    await tick();
    void first.send("r2");
    void first.send("r3");
    await tick();
    // After the reset recovery still owns r1's turn, so nothing is replayed
    // until a new request arrives.
    const b = isolate(db, {
      concurrency: "latest",
      recoveryPending: () => true
    });
    b.copyTranscript(first);
    void b.send("r4");
    await tick();
    await tick();
    await tick();
    expect(b.started).toEqual(["r4"]);
    expect(b.ended.get("r2")).toBe("skipped");
    expect(b.ended.get("r3")).toBe("skipped");
  });

  it("tabs are sent a waiting message after the transcript, named as queued", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2"]);
    const view = a.turns.clientView(a.host.transcript);
    expect(view.messages.map((m) => m.id)).toEqual(["u-r1", "u-r2"]);
    expect(view.queuedMessageIds).toEqual(["u-r2"]);
    // After a reset, before the replay, too.
    const b = isolate(db, { recoveryPending: () => true });
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
    const db = new DatabaseSync(":memory:");
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
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2", "r3"]);
    await a.turns.cancel("r2");
    a.finish("r1");
    await tick();
    await tick();
    expect(a.ended.get("r2")).toBe("aborted");
    expect(a.asked.get("r3")).toEqual(["u-r1", "u-r2", "u-r3"]);
  });

  it("a clear drops a waiting message: it is never stored", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2"]);
    a.turns.reset();
    a.host.transcript = [];
    a.finish("r1");
    await tick();
    await tick();
    expect(a.joins).toEqual(["u-r1"]);
    expect(a.turns.clientView(a.host.transcript).messages).toEqual([]);
  });

  it("drops a record older than an hour, which only a rollback leaves", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2"]);
    db.prepare("update cf_agents_chat_admissions set created_at = ?").run(
      Date.now() - 2 * 60 * 60 * 1000
    );
    const b = isolate(db);
    b.copyTranscript(a);
    await b.turns.resumeAdmissions();
    await tick();
    expect(b.replayed).toEqual([]);
    expect(b.records()).toEqual([]);
  });

  it("a replay stores nothing once a user message nothing waits on follows the one it came after", async () => {
    const db = new DatabaseSync(":memory:");
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
    let changed = 0;
    (b.host as Host & { waitingChanged(): void }).waitingChanged = () =>
      changed++;
    await b.turns.resumeAdmissions();
    await tick();
    expect(b.started).toEqual([]);
    expect(b.ended.get("r2")).toBe("skipped");
    expect(b.ids()).not.toContain("u-r2");
    // Tabs that drew it as queued are told.
    expect(changed).toBe(1);
  });

  it("a stop that lands while the replay awaits still stops the request", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2"]);
    const holder: { b?: ReturnType<typeof isolate> } = {};
    const b = isolate(db, {
      recoveryOwns: async (id) => {
        await holder.b?.turns.cancel(id);
        return false;
      }
    });
    holder.b = b;
    b.copyTranscript(a);
    await b.turns.resumeAdmissions();
    await tick();
    expect(b.started).toEqual([]);
    expect(b.ended.get("r2")).toBe("aborted");
  });

  it("a clear that lands while the replay awaits leaves nothing to replay", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2"]);
    const holder: { b?: ReturnType<typeof isolate> } = {};
    const b = isolate(db, {
      recoveryOwns: async () => {
        holder.b?.turns.reset();
        return false;
      }
    });
    holder.b = b;
    b.copyTranscript(a);
    await b.turns.resumeAdmissions();
    await tick();
    expect(b.replayed).toEqual([]);
    expect(b.started).toEqual([]);
  });
});

describe("chatRecoveryNames", () => {
  function setup(incidents: Array<Record<string, unknown>>) {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "create table cf_agents_task_runs (definition text, state text, input text)"
    );
    db.prepare("insert into cf_agents_task_runs values (?, ?, ?)").run(
      "turn",
      "running",
      JSON.stringify({ requestId: "r1" })
    );
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
