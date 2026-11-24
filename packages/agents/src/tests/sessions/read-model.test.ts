import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SessionHarnessObject } from "../capabilities/sessions";
import type { SessionMessage } from "../../sessions";
import { isCompactionMessage } from "../../sessions/compaction-helpers";

/**
 * The read model: overlays continue at a stored row below them, deletes
 * keep them applying, and overlays stored by earlier releases are carried
 * forward on start with nothing lost.
 */

function sqlOf(instance: SessionHarnessObject): SqlStorage {
  // SAFETY: tests read the object's own storage.
  return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
}

/** Seed a linear chain m<from>..m<to> in one statement. */
function seed(sql: SqlStorage, from: number, to: number, session = ""): void {
  sql.exec(
    `INSERT INTO cf_agents_session_messages
      (session_id, id, seq, parent_id, role, content, token_estimate, created_at)
     WITH RECURSIVE n(i) AS (
       SELECT CAST(? AS INTEGER) UNION ALL
       SELECT i + 1 FROM n WHERE i < CAST(? AS INTEGER))
     SELECT ?, 'm' || i, i, CASE WHEN i = 1 THEN NULL ELSE 'm' || (i - 1) END,
       'user',
       json_object('id', 'm' || i, 'role', 'user',
         'parts', json_array(json_object('type', 'text', 'text', 'x'))),
       10, i FROM n`,
    from,
    to,
    session
  );
}

function text(id: string): SessionMessage {
  return { id, role: "user", parts: [{ type: "text", text: "x" }] };
}

/** Sum `rowsRead` over every statement run inside `fn`. */
async function rowsRead(sql: SqlStorage, fn: () => Promise<unknown>) {
  const exec = sql.exec.bind(sql);
  const cursors: { readonly rowsRead: number }[] = [];
  (sql as { exec: SqlStorage["exec"] }).exec = ((
    query: string,
    ...params: unknown[]
  ) => {
    const cursor = exec(query, ...(params as never[]));
    cursors.push(cursor);
    return cursor;
    // SAFETY: forwards every argument and the cursor unchanged.
  }) as SqlStorage["exec"];
  try {
    await fn();
  } finally {
    (sql as { exec: SqlStorage["exec"] }).exec = exec;
  }
  return cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `m${from + i}`);

async function started() {
  const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
  await runInDurableObject(stub, (instance: SessionHarnessObject) =>
    instance.sessions.session().getCompactions()
  );
  return stub;
}

describe("Sessions deletes keep overlays", () => {
  async function compacted(
    fn: (
      session: ReturnType<SessionHarnessObject["sessions"]["session"]>,
      id: string
    ) => Promise<void>
  ) {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 30);
      const session = instance.sessions.session();
      const overlay = await session.addCompaction("s", "m4", "m20");
      await fn(session, `compaction_${overlay.id}`);
    });
  }

  it("keeps an overlay whose start row is deleted", async () => {
    await compacted(async (session, overlay) => {
      await session.deleteMessages(["m4"]);
      expect((await session.getHistory()).map((m) => m.id)).toEqual([
        ...range(1, 3),
        overlay,
        ...range(21, 30)
      ]);
    });
  });

  it("moves an overlay's end to the nearest surviving row when its end row is deleted", async () => {
    await compacted(async (session, overlay) => {
      await session.deleteMessages(["m20", "m19"]);
      expect((await session.getHistory()).map((m) => m.id)).toEqual([
        ...range(1, 3),
        overlay,
        ...range(21, 30)
      ]);
    });
  });

  it("continues below a deleted continuation row at its nearest survivor", async () => {
    await compacted(async (session, overlay) => {
      await session.deleteMessages(["m3"]);
      expect((await session.getHistory()).map((m) => m.id)).toEqual([
        ...range(1, 2),
        overlay,
        ...range(21, 30)
      ]);
    });
  });

  it("drops an overlay once every row it covered is gone", async () => {
    await compacted(async (session) => {
      await session.deleteMessages(range(4, 20));
      expect((await session.getHistory()).map((m) => m.id)).toEqual([
        ...range(1, 3),
        ...range(21, 30)
      ]);
      expect(await session.getCompactions()).toEqual([]);
    });
  });

  it("splices a deleted run of more than 10,000 rows", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 10_100);
      const session = instance.sessions.session();
      await session.deleteMessages(range(11, 10_050));
      expect((await session.getHistory()).map((m) => m.id)).toEqual([
        ...range(1, 10),
        ...range(10_051, 10_100)
      ]);
    });
  }, 120_000);

  it("deletes more ids than one statement binds", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 30_000);
      const session = instance.sessions.session();
      const overlay = await session.addCompaction("s", "m2", "m29990");
      // 25,000 ids: two statements. The overlay's end survives.
      await session.deleteMessages(range(11, 25_010));
      const history = (await session.getHistory()).map((m) => m.id);
      expect(history).toEqual([
        "m1",
        `compaction_${overlay.id}`,
        ...range(29_991, 30_000)
      ]);
    });
  }, 120_000);
});

describe("Sessions overlays past 10,001 rows", () => {
  it("shows the head, the summary and the tail at any length (#2871)", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 12_000);
      const session = instance.sessions.session();
      const overlay = await session.addCompaction("s", "m4", "m11980");
      const expected = [
        ...range(1, 3),
        `compaction_${overlay.id}`,
        ...range(11_981, 12_000)
      ];
      expect((await session.getHistory()).map((m) => m.id)).toEqual(expected);
      expect(
        (await session.getRecentHistory(10 * 1024 * 1024)).messages.map(
          (m) => m.id
        )
      ).toEqual(expected);
      expect((await session.getHistoryRowStats()).length).toBe(12_000);
    });
  }, 120_000);

  it("keeps the head when compact() runs again", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 100);
      const session = instance.sessions.session();
      session.onCompaction(async (messages) => ({
        summary: `s${messages.length}`,
        fromMessageId: messages[3].id,
        toMessageId: messages[messages.length - 3].id
      }));
      await session.compact();
      for (let i = 101; i <= 110; i++)
        await session.appendMessage(text(`m${i}`));
      const second = await session.compact();
      const history = await session.getHistory();
      expect(history.slice(0, 3).map((m) => m.id)).toEqual(range(1, 3));
      expect(isCompactionMessage(history[3])).toBe(true);
      expect(second?.fromMessageId).toBe("m4");
      expect(history.slice(4).map((m) => m.id)).toEqual(range(109, 110));
    });
  });
  it("re-summarizes the visible overlay when a compaction ends at its summary", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 10);
      const session = instance.sessions.session();
      let pass = 0;
      session.onCompaction(async (messages) => {
        pass++;
        return {
          summary: `pass ${pass}`,
          fromMessageId: messages[0].id,
          toMessageId: messages[0].id
        };
      });
      await session.compact();
      // The second pass starts at the first pass's summary.
      await session.compact();
      const history = await session.getHistory();
      expect(history.map((m) => m.parts[0])).toContainEqual({
        type: "text",
        text: "pass 2"
      });
      expect(history.map((m) => m.id).slice(1)).toEqual(range(2, 10));
    });
  });
});

describe("Sessions carries released overlays forward", () => {
  /** The released (agents@0.34.0) tables and schema version 1. */
  function releasedSchema(): string[] {
    return [
      `CREATE TABLE cf_agents_session_messages (
        session_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL,
        parent_id TEXT, type TEXT NOT NULL DEFAULT 'message',
        role TEXT NOT NULL, content TEXT NOT NULL,
        content_chunks INTEGER NOT NULL DEFAULT 0,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, id)
      ) WITHOUT ROWID`,
      `CREATE TABLE cf_agents_session_compactions (
        session_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL,
        summary TEXT NOT NULL, from_message_id TEXT NOT NULL,
        to_message_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, id)
      ) WITHOUT ROWID`
    ];
  }

  function releasedOverlay(
    id: string,
    seq: number,
    from: string,
    to: string,
    session = ""
  ): string {
    return `INSERT INTO cf_agents_session_compactions
      (session_id, id, seq, summary, from_message_id, to_message_id, created_at)
      VALUES ('${session}', '${id}', ${seq}, 'summary ${id}', '${from}', '${to}', 0)`;
  }

  it("migrates every released state with nothing lost", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      instance.seedLegacy(releasedSchema());
      const sql = sqlOf(instance);
      // 1: a valid overlay on a short path (session "short").
      seed(sql, 1, 30, "short");
      // 2: the #2871 shape, past 10,001 rows (default session).
      seed(sql, 1, 10_100);
      // 4: compact() twice: the same start, the newer ends later.
      // 5: a second branch with its own overlay (session "short").
      sql.exec(
        `INSERT INTO cf_agents_session_messages
          (session_id, id, seq, parent_id, role, content, token_estimate, created_at)
         VALUES ('short', 'b1', 31, 'm10', 'user',
           '{"id":"b1","role":"user","parts":[{"type":"text","text":"x"}]}', 1, 0),
         ('short', 'b2', 32, 'b1', 'user',
           '{"id":"b2","role":"user","parts":[{"type":"text","text":"x"}]}', 1, 0)`
      );
      instance.seedLegacy([
        releasedOverlay("c1", 1, "m4", "m9000"),
        releasedOverlay("c2", 2, "m4", "m10080"),
        releasedOverlay("s1", 1, "m2", "m20", "short"),
        releasedOverlay("s2", 2, "m2", "b1", "short"),
        // 6: a start row that was deleted.
        releasedOverlay("gone", 3, "deleted-row", "m25", "short"),
        // An older hand-written overlay ending on the b branch whose start
        // is not an ancestor of its end (b1 hangs off m10, not m15). Its seq
        // order is fine; it must not apply.
        releasedOverlay("cross", 0, "m15", "b2", "short")
      ]);
      await instance.kvPut("cf_agents:sessions_schema_version", 1);

      const main = instance.sessions.session();
      expect((await main.getHistory()).map((m) => m.id)).toEqual([
        ...range(1, 3),
        "compaction_c2",
        ...range(10_081, 10_100)
      ]);
      const short = instance.sessions.session("short");
      expect(
        (await short.getHistory({ leafId: "m30" })).map((m) => m.id)
      ).toEqual(["m1", "compaction_s1", ...range(21, 30)]);
      expect(
        (await short.getHistory({ leafId: "b2" })).map((m) => m.id)
      ).toEqual(["m1", "compaction_s2", "b2"]);
      // Every row of the old table is still there, summaries included.
      expect((await main.getCompactions()).map((c) => c.summary)).toEqual([
        "summary c1",
        "summary c2"
      ]);
      expect((await short.getCompactions()).map((c) => c.id)).toEqual([
        "cross",
        "s1",
        "s2",
        "gone"
      ]);
      expect(instance.eventsOfType("session:overlays:unresolved")).toEqual([
        { type: "session:overlays:unresolved", payload: { count: 2 } }
      ]);
      expect(
        await instance.kvGet<number>("cf_agents:sessions_schema_version")
      ).toBe(2);
    });
  }, 120_000);

  it("derives the continuation of an overlay an earlier release wrote after a rollback", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 30);
      // The released code's insert: seven columns, no `resume_id`.
      instance.seedLegacy([
        `INSERT INTO cf_agents_session_compactions
          (session_id, id, seq, summary, from_message_id, to_message_id, created_at)
          VALUES ('', 'r1', 1, 'summary', 'm4', 'm20', 0)`
      ]);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      expect(
        (await instance.sessions.session().getHistory()).map((m) => m.id)
      ).toEqual([...range(1, 3), "compaction_r1", ...range(21, 30)]);
    });
  });

  it("is a no-op on the next start", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 30);
      await instance.sessions.session().addCompaction("s", "m4", "m20");
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const session = instance.sessions.session();
      expect(await session.getHistory()).toHaveLength(14);
      expect(instance.eventsOfType("session:overlays:unresolved")).toEqual([]);
    });
  });
});

describe("Sessions read cost follows what the model sees", () => {
  for (const stored of [500, 10_000, 100_000]) {
    it(`reads a session compacted to 24 messages at the same cost with ${stored} rows stored`, async () => {
      const stub = await started();
      await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
        const sql = sqlOf(instance);
        seed(sql, 1, stored);
        const session = instance.sessions.session();
        // compact() run 50 times leaves 50 overlays with the same start.
        for (let i = 1; i <= 50; i++) {
          await session.addCompaction(
            "s".repeat(4_000),
            "m4",
            `m${stored - 70 + i}`
          );
        }
        await session.getLatestLeaf();
        const history = await rowsRead(sql, async () => {
          expect(await session.getHistory()).toHaveLength(24);
        });
        const recent = await rowsRead(sql, () =>
          session.getRecentHistory(1024 * 1024)
        );
        // About 5 rows per visible message, one overlay probe each, and one
        // summary: nothing proportional to the stored rows or overlays.
        expect(history).toBeLessThan(300);
        expect(recent).toBeLessThan(300);
      });
    }, 120_000);
  }
});

describe("Sessions reads past the root-first bound", () => {
  it("throws on root-first reads past 200,000 messages and serves every other read", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 200_005);
      const session = instance.sessions.session();
      await expect(session.getHistory()).rejects.toMatchObject({
        name: "SessionPathTooLongError",
        message: expect.stringMatching(/more than 200,000/)
      });
      await expect(session.getHistoryRowStats()).rejects.toThrow(
        /more than 200,000/
      );
      // Newest-first and budgeted reads hold only what they return.
      const newest: string[] = [];
      for await (const m of session.history({ newestFirst: true })) {
        newest.push(m.id);
        if (newest.length === 3) break;
      }
      expect(newest).toEqual(["m200005", "m200004", "m200003"]);
      const recent = await session.getRecentHistory(1024);
      expect(recent.truncated).toBe(true);
      expect(recent.messages.at(-1)?.id).toBe("m200005");
      // Callers that count stored rows (retention, media eviction) page.
      expect(
        (
          await session.internal_storedPathRows({ skip: 200_000, limit: 10 })
        ).map((row) => row.id)
      ).toEqual(["m5", "m4", "m3", "m2", "m1"]);
      // A page continues below the last row of the one before: each row once.
      const first = await session.internal_storedPathRows({
        skip: 0,
        limit: 3
      });
      const next = await session.internal_storedPathRows({
        skip: 0,
        limit: 3,
        after: first[first.length - 1].id
      });
      expect([...first, ...next].map((row) => row.id)).toEqual([
        "m200005",
        "m200004",
        "m200003",
        "m200002",
        "m200001",
        "m200000"
      ]);
    });
  }, 120_000);
});

describe("Sessions budgeted reads bound the message count", () => {
  it("charges each message 1 KiB beyond its stored bytes", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      // 10,000 messages of a few dozen stored bytes.
      seed(sqlOf(instance), 1, 10_000);
      const session = instance.sessions.session();
      const recent = await session.getRecentHistory(1024 * 1024);
      // Stored bytes alone would admit all 10,000.
      expect(recent.messages.length).toBeLessThanOrEqual(1024);
      expect(recent.messages.length).toBeGreaterThan(900);
      expect(recent.truncated).toBe(true);
      expect(recent.messages.at(-1)?.id).toBe("m10000");
    });
  }, 120_000);
});

describe("Sessions legacy stored summaries and hidden rows", () => {
  it("removes a summary's stored copy with the summary when its range is deleted", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 30);
      const session = instance.sessions.session();
      const overlay = await session.addCompaction("s", "m4", "m20");
      // A copy of the summary an earlier release stored as a row (#1984).
      sqlOf(instance).exec(
        `INSERT INTO cf_agents_session_messages
          (session_id, id, seq, parent_id, role, content, token_estimate, created_at)
         VALUES ('', ?, 31, 'm30', 'assistant',
           json_object('id', ?, 'role', 'assistant',
             'parts', json_array(json_object('type', 'text', 'text', 's'))), 1, 31)`,
        `compaction_${overlay.id}`,
        `compaction_${overlay.id}`
      );
      await session.appendMessage(text("m32"), {
        parentId: `compaction_${overlay.id}`
      });
      await session.deleteMessages(range(4, 20));
      expect((await session.getHistory()).map((m) => m.id)).toEqual([
        ...range(1, 3),
        ...range(21, 30),
        "m32"
      ]);
    });
  });

  it("counts only visible rows when a stored-path page skips the newest", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 10);
      const session = instance.sessions.session();
      const overlay = await session.addCompaction("s", "m1", "m1");
      // A hidden stored summary row just below the leaf.
      sqlOf(instance).exec(
        `INSERT INTO cf_agents_session_messages
          (session_id, id, seq, parent_id, role, content, token_estimate, created_at)
         VALUES ('', ?, 11, 'm10', 'assistant', '{}', 1, 11)`,
        `compaction_${overlay.id}`
      );
      await session.appendMessage(text("m12"), {
        parentId: `compaction_${overlay.id}`
      });
      const page = await session.internal_storedPathRows({
        skip: 2,
        limit: 3
      });
      expect(page.map((row) => row.id)).toEqual(["m9", "m8", "m7"]);
    });
  });
});
