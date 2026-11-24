import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SessionHarnessObject } from "../capabilities/sessions";
import type { SessionMessage } from "../../sessions";
import { isCompactionMessage } from "../../sessions/compaction-helpers";

/**
 * Session annotations and config: server-side data a first-party module
 * keeps about a session's messages (Think's context records), on a real
 * Durable Object with a real Lifecycle and SQLite.
 */

function text(id: string): SessionMessage {
  return { id, role: "user", parts: [{ type: "text", text: id }] };
}

function sqlOf(instance: SessionHarnessObject): SqlStorage {
  // SAFETY: tests read the object's own storage.
  return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
}

/** Sum `rowsRead` and `rowsWritten` over every statement run inside `fn`. */
async function meter(sql: SqlStorage, fn: () => Promise<unknown>) {
  const exec = sql.exec.bind(sql);
  const cursors: { readonly rowsRead: number; readonly rowsWritten: number }[] =
    [];
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
  return {
    rowsRead: cursors.reduce((sum, c) => sum + c.rowsRead, 0),
    rowsWritten: cursors.reduce((sum, c) => sum + c.rowsWritten, 0)
  };
}

async function withSession(
  fn: (
    session: ReturnType<SessionHarnessObject["sessions"]["session"]>,
    instance: SessionHarnessObject
  ) => Promise<void>
) {
  const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
    await fn(instance.sessions.session(), instance);
  });
}

async function appendAll(
  session: ReturnType<SessionHarnessObject["sessions"]["session"]>,
  from: number,
  to: number
) {
  for (let i = from; i <= to; i++) await session.appendMessage(text(`m${i}`));
}

describe("Session annotations", () => {
  it("reads back only the annotated ids, and an upsert replaces the value", async () => {
    await withSession(async (session) => {
      await appendAll(session, 1, 3);
      await session.internal_setAnnotation("ctx", "m1", "a");
      await session.internal_setAnnotation("ctx", "m3", "b");
      await session.internal_setAnnotation("other", "m2", "x");
      await session.internal_setAnnotation("ctx", "m3", "c");
      const found = await session.internal_annotations("ctx", [
        "m1",
        "m2",
        "m3",
        "missing"
      ]);
      expect([...found]).toEqual([
        ["m1", "a"],
        ["m3", "c"]
      ]);
      // Never part of the message.
      const [m1] = await session.getHistory();
      expect(JSON.stringify(m1)).not.toContain('"a"');
    });
  });

  it("goes with its message on delete and with the session on clear", async () => {
    await withSession(async (session) => {
      await appendAll(session, 1, 3);
      await session.internal_setAnnotation("ctx", "m2", "a");
      await session.internal_setAnnotation("ctx", "m3", "b");
      await session.deleteMessages(["m2"]);
      expect([
        ...(await session.internal_annotations("ctx", ["m2", "m3"]))
      ]).toEqual([["m3", "b"]]);

      await session.clearMessages();
      await appendAll(session, 3, 3);
      // A new row reusing an old id does not inherit the old annotation.
      expect((await session.internal_annotations("ctx", ["m3"])).size).toBe(0);
    });
  });

  it("an overlay carries the newest annotation of each kind it hides", async () => {
    await withSession(async (session) => {
      await appendAll(session, 1, 10);
      await session.internal_setAnnotation("ctx", "m3", "old");
      await session.internal_setAnnotation("ctx", "m6", "new");
      await session.internal_setAnnotation("remind", "m4", "r");
      // Outside the span: not carried.
      await session.internal_setAnnotation("ctx", "m9", "after");
      const overlay = await session.addCompaction("summary", "m2", "m8");
      const overlayId = `compaction_${overlay.id}`;

      const ctx = await session.internal_annotations("ctx", [overlayId]);
      expect(ctx.get(overlayId)).toBe("new");
      const remind = await session.internal_annotations("remind", [overlayId]);
      expect(remind.get(overlayId)).toBe("r");
      // The hidden rows keep theirs: an overlay hides, it does not delete.
      expect(
        (await session.internal_annotations("ctx", ["m6"])).get("m6")
      ).toBe("new");
    });
  });

  it("a replacing overlay carries an annotation set on the overlay it hides", async () => {
    await withSession(async (session) => {
      await appendAll(session, 1, 20);
      await session.internal_setAnnotation("ctx", "m5", "row");
      const first = await session.addCompaction("first", "m2", "m10");
      const firstId = `compaction_${first.id}`;
      // A record set on the summary itself, after the first compaction.
      await session.internal_setAnnotation("ctx", firstId, "on overlay");
      const second = await session.addCompaction("second", "m2", "m15");
      const secondId = `compaction_${second.id}`;
      expect(
        (await session.internal_annotations("ctx", [secondId])).get(secondId)
      ).toBe("on overlay");
    });
  });

  it("carries the summary the walk applies, not one it superseded at the same row", async () => {
    await withSession(async (session) => {
      await appendAll(session, 1, 20);
      const older = await session.addCompaction("older", "m2", "m10");
      await session.internal_setAnnotation(
        "ctx",
        `compaction_${older.id}`,
        "stale"
      );
      // A re-summary over the same range: the walk now applies this one.
      const newer = await session.addCompaction("newer", "m2", "m10");
      await session.internal_setAnnotation(
        "ctx",
        `compaction_${newer.id}`,
        "fresh"
      );
      const wider = await session.addCompaction("wider", "m2", "m15");
      const id = `compaction_${wider.id}`;
      expect((await session.internal_annotations("ctx", [id])).get(id)).toBe(
        "fresh"
      );
    });
  });

  it("carries nothing from the kept head after a summary's start row is deleted", async () => {
    await withSession(async (session) => {
      await appendAll(session, 1, 20);
      await session.internal_setAnnotation("ctx", "m2", "head");
      await session.addCompaction("s", "m4", "m10");
      await session.deleteMessages(["m4"]);
      session.onCompaction(async (messages) => ({
        summary: "extended",
        fromMessageId: messages[3].id,
        toMessageId: messages[messages.length - 3].id
      }));
      await session.compact();
      const history = await session.getHistory();
      const overlay = history.find((m) => m.id.startsWith("compaction_"));
      expect(overlay?.parts[0]).toMatchObject({ text: "extended" });
      expect(history.slice(0, 3).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
      expect(
        (await session.internal_annotations("ctx", [overlay?.id ?? ""])).size
      ).toBe(0);
    });
  });

  it("compact() carries annotations onto its overlay", async () => {
    await withSession(async (session) => {
      await appendAll(session, 1, 10);
      await session.internal_setAnnotation("ctx", "m5", "snap");
      session.onCompaction(async (messages) => ({
        summary: "s",
        fromMessageId: messages[1].id,
        toMessageId: messages[7].id
      }));
      await session.compact();
      const [overlay] = (await session.getHistory()).filter(
        isCompactionMessage
      );
      const found = await session.internal_annotations("ctx", [overlay.id]);
      expect(found.get(overlay.id)).toBe("snap");
    });
  });

  it("finds the newest annotation on the visible path, through an overlay", async () => {
    await withSession(async (session) => {
      await appendAll(session, 1, 10);
      expect(await session.internal_latestAnnotation("ctx")).toBeNull();

      await session.internal_setAnnotation("ctx", "m2", "head");
      await session.internal_setAnnotation("ctx", "m5", "hidden");
      expect(await session.internal_latestAnnotation("ctx")).toEqual({
        messageId: "m5",
        value: "hidden"
      });

      // m3..m8 compacted. m5's record now lives on the overlay message,
      // which is what the visible path shows.
      const overlay = await session.addCompaction("summary", "m3", "m8");
      expect(await session.internal_latestAnnotation("ctx")).toEqual({
        messageId: `compaction_${overlay.id}`,
        value: "hidden"
      });

      // A newer visible row wins.
      await session.internal_setAnnotation("ctx", "m10", "tail");
      expect(await session.internal_latestAnnotation("ctx")).toEqual({
        messageId: "m10",
        value: "tail"
      });
      // From an older leaf, only that leaf's visible path counts.
      expect(await session.internal_latestAnnotation("ctx", "m9")).toEqual({
        messageId: `compaction_${overlay.id}`,
        value: "hidden"
      });
    });
  });

  it("does not find an annotation on a sibling branch", async () => {
    await withSession(async (session) => {
      await appendAll(session, 1, 3);
      await session.appendMessage(text("b1"), { parentId: "m1" });
      await session.internal_setAnnotation("ctx", "b1", "branch");
      expect(await session.internal_latestAnnotation("ctx", "m3")).toBeNull();
      expect(await session.internal_latestAnnotation("ctx", "b1")).toEqual({
        messageId: "b1",
        value: "branch"
      });
    });
  });

  it("costs nothing extra for a session that never annotates", async () => {
    await withSession(async (session, instance) => {
      await appendAll(session, 1, 20);
      const sql = sqlOf(instance);
      const latest = await meter(sql, () =>
        session.internal_latestAnnotation("ctx")
      );
      // One primary-key probe that finds nothing.
      expect(latest).toEqual({ rowsRead: 0, rowsWritten: 0 });
      const compaction = await meter(sql, () =>
        session.addCompaction("summary", "m2", "m10")
      );
      // The overlay row, and nothing carried.
      expect(compaction.rowsWritten).toBe(1);
    });
  });
});

describe("Session annotations at size", () => {
  it("finds a record near the leaf in a few rows at 10,000 stored rows", async () => {
    await withSession(async (session, instance) => {
      await session.getCompactions();
      const sql = sqlOf(instance);
      sql.exec(
        `INSERT INTO cf_agents_session_messages
          (session_id, id, seq, parent_id, role, content, token_estimate, created_at)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
         SELECT '', 'm' || i, i, CASE WHEN i = 1 THEN NULL ELSE 'm' || (i - 1) END,
           'user', json_object('id', 'm' || i, 'role', 'user', 'parts', json_array()),
           1, i FROM n`
      );
      // One record per 100 rows, the newest one row from the leaf.
      for (let i = 99; i <= 9999; i += 100) {
        await session.internal_setAnnotation("ctx", `m${i}`, `v${i}`);
      }
      await session.getLatestLeaf();
      let found: { messageId: string; value: string } | null = null;
      const read = await meter(sql, async () => {
        found = await session.internal_latestAnnotation("ctx");
      });
      expect(found).toEqual({ messageId: "m9999", value: "v9999" });
      expect(read.rowsRead).toBeLessThan(50);
    });
  }, 120_000);
});

describe("Session config", () => {
  it("sets, reads and deletes a value", async () => {
    await withSession(async (session) => {
      expect(await session.internal_config("k")).toBeNull();
      await session.internal_setConfig("k", "1");
      await session.internal_setConfig("k", "2");
      expect(await session.internal_config("k")).toBe("2");
      await session.internal_setConfig("k", null);
      expect(await session.internal_config("k")).toBeNull();
    });
  });

  it("clearMessages deletes transcript: keys and keeps the rest", async () => {
    await withSession(async (session) => {
      await appendAll(session, 1, 2);
      await session.internal_setConfig("transcript:context:refresh", "1");
      await session.internal_setConfig("transcript;", "edge");
      await session.internal_setConfig("epoch", "7");
      await session.clearMessages();
      expect(
        await session.internal_config("transcript:context:refresh")
      ).toBeNull();
      expect(await session.internal_config("transcript;")).toBe("edge");
      expect(await session.internal_config("epoch")).toBe("7");
    });
  });

  it("is per session", async () => {
    await withSession(async (_session, instance) => {
      const a = instance.sessions.session("a");
      const b = instance.sessions.session("b");
      await a.internal_setConfig("transcript:k", "a");
      await b.internal_setConfig("transcript:k", "b");
      await a.clearMessages();
      expect(await a.internal_config("transcript:k")).toBeNull();
      expect(await b.internal_config("transcript:k")).toBe("b");
    });
  });

  it("carries past an older overlay by its summary, not row by row", async () => {
    await withSession(async (session, instance) => {
      const sql = sqlOf(instance);
      await session.getCompactions();
      sql.exec(
        `INSERT INTO cf_agents_session_messages
          (session_id, id, seq, parent_id, role, content, token_estimate, created_at)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 15000)
         SELECT '', 'm' || i, i, CASE WHEN i = 1 THEN NULL ELSE 'm' || (i - 1) END,
           'user', json_object('id', 'm' || i, 'role', 'user',
             'parts', json_array(json_object('type', 'text', 'text', 'x'))),
           1, i FROM n`
      );
      await session.internal_setAnnotation("ctx", "m50", "a");
      const first = await meter(sql, () =>
        session.addCompaction("first", "m1", "m10000")
      );
      // One message lookup and one overlay probe per step: the first
      // compaction costs what it did before the walk could jump (60,013).
      expect(first.rowsRead).toBeLessThan(61_000);
      // The first overlay carried m50's value; the row itself can go.
      await session.deleteMessages(["m50"]);
      const { rowsRead } = await meter(sql, () =>
        session.addCompaction("second", "m1", "m15000")
      );
      const latest = await session.internal_latestAnnotation("ctx");
      expect(latest?.value).toBe("a");
      // The carry walks the 5,000 rows above the first overlay and takes
      // its summary's value, instead of the 15,000 rows down to the root
      // (90,010 rows read before, 50,020 now; the rest is the compaction's
      // own checks).
      expect(rowsRead).toBeLessThan(60_000);
    });
  }, 120_000);
});
