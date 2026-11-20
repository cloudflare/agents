import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  chatRecoveryNames,
  createChatAdmissionStore,
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

  const request = (
    requestId: string,
    replay = false
  ): ClientChatRequest<true> => ({
    requestId,
    isSubmitMessage: true,
    concurrency: options.concurrency ?? "queue",
    admission: { messageIds: [`u-${requestId}`], payload: { requestId } },
    onDropped: () => ended.set(requestId, "skipped"),
    persist: async () => {
      if (!replay)
        host.transcript.push({ id: `u-${requestId}`, role: "user", parts: [] });
      return host.transcript.some((m) => m.id === `u-${requestId}`)
        ? true
        : null;
    },
    enqueue: async (turn, generation, onQueued) => {
      const done = turns.queue.enqueue(requestId, turn, { generation });
      onQueued();
      const result = await done;
      return result.status === "stale" ? "stale" : "completed";
    },
    run: async () => {
      started.push(requestId);
      // The turn's fiber is accepted.
      turns.turnAccepted(requestId);
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
        return request(record.requestId, true);
      }
    }
  });

  return {
    turns,
    host,
    ended,
    started,
    replayed,
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

  it("ends `skipped` a request whose message is gone", async () => {
    const db = new DatabaseSync(":memory:");
    await queueBehindRunningTurn(db, ["r2"]);
    const b = isolate(db);
    await b.turns.resumeAdmissions();
    await tick();
    expect(b.started).toEqual([]);
    expect(b.ended.get("r2")).toBe("skipped");
    expect(b.records()).toEqual([]);
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
  });

  it("the user messages of recorded requests are known, for recovery's leaf", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2"]);
    expect([...a.turns.admittedMessageIds()]).toEqual(["u-r2"]);
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

  it("a replay has nothing to answer once a user message nothing waits on follows its own", async () => {
    const db = new DatabaseSync(":memory:");
    const a = await queueBehindRunningTurn(db, ["r2"]);
    const msg = (id: string, role: string) => ({ id, role, parts: [] });
    const t = a.turns;
    expect(t.replayHasNothingToAnswer(["u-r2"], [msg("u-r2", "user")])).toBe(
      false
    );
    // A reply after it (the recovered turn's) does not move it on.
    expect(
      t.replayHasNothingToAnswer(
        ["u-r2"],
        [msg("u-r2", "user"), msg("a1", "assistant")]
      )
    ).toBe(false);
    // A question an older release answered after a rollback does.
    expect(
      t.replayHasNothingToAnswer(
        ["u-r2"],
        [msg("u-r2", "user"), msg("u3", "user")]
      )
    ).toBe(true);
    // Gone.
    expect(t.replayHasNothingToAnswer(["u-r2"], [])).toBe(true);
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
