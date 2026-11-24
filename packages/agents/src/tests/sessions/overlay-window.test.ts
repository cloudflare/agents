import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SessionHarnessObject } from "../capabilities/sessions";
import type { SessionMessage } from "../../sessions";
import { isCompactionMessage } from "../../sessions/compaction-helpers";

/**
 * Long paths and byte budgets must not turn a compaction overlay off
 * (#2871), and no read may cost rows in proportion to the session rather
 * than to what it returns. The walk resolves from the leaf: past an overlay
 * it continues at the row below it, so the head the compaction kept comes
 * back with the summary however long the path is.
 */

function sqlOf(instance: SessionHarnessObject): SqlStorage {
  // SAFETY: tests read the object's own storage.
  return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
}

/** Seed a linear chain m<from>..m<to> in one statement. */
function seed(sql: SqlStorage, from: number, to: number, bodyBytes = 16): void {
  sql.exec(
    `INSERT INTO cf_agents_session_messages
      (session_id, id, seq, parent_id, role, content, token_estimate, created_at)
     WITH RECURSIVE n(i) AS (
       SELECT CAST(? AS INTEGER) UNION ALL
       SELECT i + 1 FROM n WHERE i < CAST(? AS INTEGER))
     SELECT '', 'm' || i, i, CASE WHEN i = 1 THEN NULL ELSE 'm' || (i - 1) END,
       CASE WHEN i % 2 = 1 THEN 'user' ELSE 'assistant' END,
       json_object('id', 'm' || i,
         'role', CASE WHEN i % 2 = 1 THEN 'user' ELSE 'assistant' END,
         'parts', json_array(json_object('type', 'text',
           'text', printf('%.*c', CAST(? AS INTEGER), 'x')))),
       10, i FROM n`,
    from,
    to,
    bodyBytes
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

async function open(name = crypto.randomUUID()) {
  const stub = env.SessionHarnessObject.getByName(name);
  // Start the object so its tables exist before rows are seeded.
  await runInDurableObject(stub, (instance: SessionHarnessObject) =>
    instance.sessions.session().getCompactions()
  );
  return stub;
}

describe("Sessions path reads cut by a window", () => {
  it("keeps an overlay applied after its start row leaves the depth window (#2871)", async () => {
    const stub = await open();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 9990);
      const session = instance.sessions.session();
      await session.addCompaction("summary", "m4", "m9970");
      for (let i = 9991; i <= 10100; i++) {
        await session.appendMessage(text(`m${i}`));
      }

      const history = await session.getHistory();
      // The head m1..m3, the summary, then every row after the overlay's
      // end: m9971..m10100.
      expect(history.slice(0, 3).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
      expect(isCompactionMessage(history[3])).toBe(true);
      expect(history.slice(4).map((m) => m.id)).toEqual(
        Array.from({ length: 130 }, (_, i) => `m${9971 + i}`)
      );

      const newestFirst: string[] = [];
      for await (const m of session.history({ newestFirst: true })) {
        newestFirst.push(m.id);
      }
      expect(newestFirst).toEqual(history.map((m) => m.id).reverse());
    });
  }, 60_000);

  it("keeps the overlay when compact() runs on a path past the depth window", async () => {
    const stub = await open();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 12000);
      const session = instance.sessions.session();
      session.onCompaction(async (messages) => ({
        summary: "summary",
        fromMessageId: messages[0].id,
        toMessageId: messages[messages.length - 21].id
      }));
      // Each round takes the oldest part within the compaction budget.
      for (let round = 0; round < 6; round++) {
        if ((await session.getHistory()).length <= 21) break;
        await session.compact();
      }
      expect(await session.getHistory()).toHaveLength(21);
      await session.appendMessage(text("m12001"));
      const history = await session.getHistory();
      expect(history).toHaveLength(22);
      expect(isCompactionMessage(history[0])).toBe(true);
    });
  }, 60_000);

  it("keeps an overlay applied when a byte budget starts the window inside it", async () => {
    const stub = await open();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      // About 2 MB of raw rows, compacted to a summary and 20 messages.
      seed(sqlOf(instance), 1, 2000, 1000);
      const session = instance.sessions.session();
      await session.addCompaction("summary", "m1", "m1980");
      const full = await session.getHistory();
      expect(full).toHaveLength(21);

      const recent = await session.getRecentHistory(1024 * 1024);
      expect(recent.messages.map((m) => m.id)).toEqual(full.map((m) => m.id));
    });
  });

  it("reads rows in proportion to the path, not to the session", async () => {
    const stub = await open();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const sql = sqlOf(instance);
      seed(sql, 1, 20_000);
      const session = instance.sessions.session();
      // Settle the once-per-object tail lookup outside the measurement.
      await session.getLatestLeaf();

      // A 100-row path inside a 20,000-row session.
      const stats = await rowsRead(sql, () =>
        session.getHistoryRowStats("m100")
      );
      expect(stats).toBeLessThan(1_000);
      const history = await rowsRead(sql, () =>
        session.getHistory({ leafId: "m100" })
      );
      expect(history).toBeLessThan(1_500);
    });
  });

  it("counts tokens over the clipped answer, so compactAfter does not fire on a small visible path", async () => {
    const stub = await open();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 9990);
      const session = instance.sessions.session();
      await session.addCompaction("summary", "m4", "m9970");
      for (let i = 9991; i <= 10100; i++) {
        await session.appendMessage(text(`m${i}`));
      }
      // Visible: the summary and about 130 rows of 10 tokens. The raw
      // window would be 10,001 rows.
      let compactions = 0;
      session
        .onCompaction(async () => {
          compactions++;
          return null;
        })
        .compactAfter(5_000);
      await session.appendMessage(text("m10101"));
      expect(compactions).toBe(0);
    });
  }, 60_000);

  it("shows the head below the overlay in a budgeted read", async () => {
    const stub = await open();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 2000, 1000);
      const session = instance.sessions.session();
      await session.addCompaction("summary", "m4", "m1980");
      expect(await session.getHistory()).toHaveLength(24);

      // The visible path is about 24 KB: it fits, head included.
      const recent = await session.getRecentHistory(1024 * 1024);
      expect(recent.messages).toHaveLength(24);
      expect(isCompactionMessage(recent.messages[3])).toBe(true);
      expect(recent.truncated).toBe(false);
    });
  });

  it("reports a budgeted read as complete when the overlay starts at the root", async () => {
    const stub = await open();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 2000, 1000);
      const session = instance.sessions.session();
      await session.addCompaction("summary", "m1", "m1980");
      const recent = await session.getRecentHistory(1024 * 1024);
      expect(isCompactionMessage(recent.messages[0])).toBe(true);
      expect(recent.truncated).toBe(false);
    });
  });

  it("refuses an overlay anchored on another branch", async () => {
    const stub = await open();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 20);
      const session = instance.sessions.session();
      await session.appendMessage(text("b1"), { parentId: "m1" });
      await expect(
        session.addCompaction("summary", "b1", "m15")
      ).rejects.toThrow(/not on the path/);
      await expect(
        session.addCompaction("summary", "m15", "m4")
      ).rejects.toThrow(/not on the path/);
      await expect(
        session.addCompaction("summary", "missing", "m4")
      ).rejects.toThrow(/not a message/);
      expect(await session.getCompactions()).toEqual([]);
    });
  });

  it("refuses an overlay anchored on an older sibling branch", async () => {
    const stub = await open();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 2000, 1000);
      // A sibling of m2 under m1, numbered before every other row.
      sqlOf(instance).exec(
        `INSERT INTO cf_agents_session_messages
          (session_id, id, seq, parent_id, role, content, token_estimate, created_at)
         VALUES ('', 's', 0, 'm1', 'user',
           '{"id":"s","role":"user","parts":[{"type":"text","text":"s"}]}', 1, 0)`
      );
      const session = instance.sessions.session();
      await expect(
        session.addCompaction("summary", "s", "m1990")
      ).rejects.toThrow(/not on the path/);
      const recent = await session.getRecentHistory(1024 * 1024, {
        leafId: "m2000"
      });
      expect(recent.messages.some(isCompactionMessage)).toBe(false);
    });
  });

  it("applies the newest overlay ending on the path, and a budgeted read is the tail of the full read", async () => {
    const stub = await open();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 100, 1000);
      const session = instance.sessions.session();
      await session.addCompaction("a", "m1", "m40");
      const b = await session.addCompaction("b", "m30", "m80");
      // The walk reaches m80 first: b applies and continues at m29; a ends
      // inside b's range and is not reached.
      const full = (await session.getHistory()).map((m) => m.id);
      expect(full).toEqual([
        ...Array.from({ length: 29 }, (_, i) => `m${1 + i}`),
        `compaction_${b.id}`,
        ...Array.from({ length: 20 }, (_, i) => `m${81 + i}`)
      ]);
      const stats = await session.getHistoryRowStats();
      // The 20 newest rows and the summary, each charged 1 KiB on top.
      const budget =
        stats.slice(-20).reduce((sum, row) => sum + row.bytes, 0) +
        21 * 1024 +
        1 +
        // Room for a few rows of the head (about 1 KB each, plus 1 KiB).
        6_000;
      const recent = await session.getRecentHistory(budget);
      expect(recent.messages.map((m) => m.id)).toEqual(
        full.slice(full.length - recent.messages.length)
      );
      expect(recent.messages.length).toBeGreaterThan(21);
      expect(recent.truncated).toBe(true);
    });
  });

  it("applies the overlay that ends latest on the path when two share a start", async () => {
    const stub = await open();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 100, 1000);
      const session = instance.sessions.session();
      const longer = await session.addCompaction("longer", "m1", "m80");
      await session.addCompaction("shorter", "m1", "m40");
      const full = (await session.getHistory()).map((m) => m.id);
      expect(full[0]).toBe(`compaction_${longer.id}`);
      expect(full).toHaveLength(21);
      const stats = await session.getHistoryRowStats();
      const budget =
        stats.slice(-10).reduce((sum, row) => sum + row.bytes, 0) + 10 * 1024;
      const recent = await session.getRecentHistory(budget);
      expect(recent.messages.map((m) => m.id)).toEqual(full.slice(-10));
    });
  });

  it("keeps a budgeted read within its budget when a clipped summary is larger than the rows it replaces", async () => {
    const stub = await open();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      seed(sqlOf(instance), 1, 2000, 1000);
      const session = instance.sessions.session();
      await session.addCompaction("s".repeat(50_000), "m1", "m1990");
      // Ten rows of about 1 KB, each charged 1 KiB on top: about 30 KB.
      const recent = await session.getRecentHistory(30 * 1024);
      // The summary (50 KB) does not fit after them.
      expect(recent.messages.map((m) => m.id)).toEqual(
        Array.from({ length: 10 }, (_, i) => `m${1991 + i}`)
      );
      expect(recent.truncated).toBe(true);
    });
  });

  it("reads one summary when many stored summaries share a start", async () => {
    const stub = await open();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const sql = sqlOf(instance);
      seed(sql, 1, 20_000);
      // What 50 runs of compact() leave: one start, ends 100 rows apart.
      for (let i = 1; i <= 50; i++) {
        sql.exec(
          `INSERT INTO cf_agents_session_compactions
            (session_id, to_message_id, seq, id, summary, from_message_id, resume_id, created_at)
           VALUES ('', ?, ?, ?, ?, 'm4', 'm3', 0)`,
          `m${10_000 + 100 * i}`,
          i,
          `c${i}`,
          `summary ${i}`
        );
      }
      const session = instance.sessions.session();
      await session.getLatestLeaf();
      let history: SessionMessage[] = [];
      const read = await rowsRead(sql, async () => {
        history = await session.getHistory();
      });
      expect(history.slice(0, 4).map((m) => m.id)).toEqual([
        "m1",
        "m2",
        "m3",
        "compaction_c50"
      ]);
      expect(history).toHaveLength(4 + 5_000);
      // The visible rows only: a few rows read each.
      expect(read).toBeLessThan(5_004 * 5);
    });
  }, 120_000);

  it("refuses summaries anchored on another branch and applies the one on the path", async () => {
    const stub = await open();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const sql = sqlOf(instance);
      seed(sql, 1, 2000, 1000);
      // A sibling of m2 under m1, numbered before every other row.
      sql.exec(
        `INSERT INTO cf_agents_session_messages
          (session_id, id, seq, parent_id, role, content, token_estimate, created_at)
         VALUES ('', 's', 0, 'm1', 'user',
           '{"id":"s","role":"user","parts":[{"type":"text","text":"s"}]}', 1, 0)`
      );
      const session = instance.sessions.session();
      await expect(
        session.addCompaction("sibling a", "s", "m1985")
      ).rejects.toThrow(/not on the path/);
      await expect(
        session.addCompaction("sibling b", "s", "m1990")
      ).rejects.toThrow(/not on the path/);
      const onPath = await session.addCompaction("on path", "m4", "m1980");
      const recent = await session.getRecentHistory(1024 * 1024);
      expect(
        recent.messages.filter(isCompactionMessage).map((m) => m.id)
      ).toEqual([`compaction_${onPath.id}`]);
      expect(recent.messages.at(-1)?.id).toBe("m2000");
    });
  });
});
