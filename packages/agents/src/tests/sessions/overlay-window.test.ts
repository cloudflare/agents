import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SessionHarnessObject } from "../capabilities/sessions";
import type { SessionMessage } from "../../sessions";

/**
 * A compaction overlay must keep applying when the path read is cut short:
 * by the 10,001-row path cap (#2871) or by a byte budget. A cut window that
 * starts inside an overlay's span shows the overlay from the window's first
 * row; before, the overlay was dropped and the raw rows came back.
 *
 * Also pins the cost of a path read: it follows the path, not every row
 * stored in the session.
 */

function sqlOf(instance: SessionHarnessObject): SqlStorage {
  return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
}

/** Seed a linear chain m<from>..m<to> in one statement (before the tail is cached). */
function seed(sql: SqlStorage, from: number, to: number, bodyBytes = 16) {
  sql.exec(
    `INSERT INTO cf_agents_session_messages
      (session_id, id, seq, parent_id, role, content, token_estimate, created_at)
     WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i < CAST(? AS INTEGER))
     SELECT '', 'm' || i, i, CASE WHEN i = 1 THEN NULL ELSE 'm' || (i - 1) END,
       CASE WHEN i % 2 = 1 THEN 'user' ELSE 'assistant' END,
       json_object('id', 'm' || i, 'role', CASE WHEN i % 2 = 1 THEN 'user' ELSE 'assistant' END,
         'parts', json_array(json_object('type', 'text', 'text', printf('%.*c', CAST(? AS INTEGER), 'x')))),
       10, i FROM n`,
    from,
    to,
    bodyBytes
  );
}

function text(id: string): SessionMessage {
  return { id, role: "user", parts: [{ type: "text", text: "x" }] };
}

/** Count rows read by every statement issued while `run` executes. */
async function rowsReadBy(
  sql: SqlStorage,
  run: () => Promise<unknown>
): Promise<number> {
  const exec = sql.exec.bind(sql);
  const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  const metered = sql as { exec: SqlStorage["exec"] };
  metered.exec = ((query: string, ...params: unknown[]) => {
    const cursor = exec(query, ...(params as SqlStorageValue[]));
    cursors.push(cursor);
    return cursor;
  }) as SqlStorage["exec"];
  try {
    await run();
  } finally {
    metered.exec = exec;
  }
  return cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
}

describe("Sessions overlays on a cut path window", () => {
  it("an overlay keeps applying after its start leaves the 10,001-row path window (#2871)", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      await instance.sessions.session().getCompactions();
      seed(sqlOf(instance), 1, 9990);
      const session = instance.sessions.session();
      // Overlay from row 4 (the reference function's protected head is
      // rows 1-3), leaving the last 20 rows raw.
      await session.addCompaction("summary", "m4", "m9970");
      expect(await session.getHistory()).toHaveLength(24);

      for (let i = 9991; i <= 10100; i++) {
        await session.appendMessage(text(`m${i}`));
      }
      const history = await session.getHistory();
      // The window m100..m10100 starts inside the overlay: the summary,
      // then the 130 rows after it. The head m1..m3 is older than the
      // window and is not shown.
      expect(history).toHaveLength(1 + 130);
      expect(history[0].id.startsWith("compaction_")).toBe(true);
      expect(history[1].id).toBe("m9971");
      expect(history.at(-1)?.id).toBe("m10100");

      let newestFirst = 0;
      let oldest = "";
      for await (const message of session.history({ newestFirst: true })) {
        newestFirst++;
        oldest = message.id;
      }
      expect(newestFirst).toBe(131);
      expect(oldest.startsWith("compaction_")).toBe(true);

      // The token estimate follows the same answer (summary plus about
      // 130 rows of 10 tokens), so a 5,000-token threshold does not fire.
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
  }, 120_000);

  it("compact() past the path cap keeps its overlay after the next append", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      await instance.sessions.session().getCompactions();
      seed(sqlOf(instance), 1, 12000);
      const session = instance.sessions.session();
      session.onCompaction(async (messages) => ({
        summary: "s",
        fromMessageId: messages[0].id,
        toMessageId: messages[messages.length - 21].id
      }));
      await session.compact();
      expect(await session.getHistory()).toHaveLength(21);
      await session.appendMessage(text("m12001"));
      // The overlay's start (the window's oldest row then) is now outside
      // the window; the overlay still applies.
      const history = await session.getHistory();
      expect(history).toHaveLength(22);
      expect(history[0].id.startsWith("compaction_")).toBe(true);
    });
  }, 120_000);

  it("a byte-budgeted read keeps an overlay whose start is older than the budget window", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      await instance.sessions.session().getCompactions();
      // 2,000 rows of about 1 KB, compacted down to 21 messages.
      seed(sqlOf(instance), 1, 2000, 1000);
      const session = instance.sessions.session();
      await session.addCompaction("summary", "m1", "m1980");
      expect(await session.getHistory()).toHaveLength(21);

      const recent = await session.getRecentHistory(1024 * 1024);
      expect(recent.messages).toHaveLength(21);
      expect(recent.messages[0].id.startsWith("compaction_")).toBe(true);
      expect(recent.messages[1].id).toBe("m1981");
      // The overlay starts at the root: nothing older is missing.
      expect(recent.truncated).toBe(false);
    });
  }, 120_000);

  it("a byte-budgeted read that clips an overlay with a head before it is truncated", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      await instance.sessions.session().getCompactions();
      seed(sqlOf(instance), 1, 2000, 1000);
      const session = instance.sessions.session();
      await session.addCompaction("summary", "m4", "m1980");
      expect(await session.getHistory()).toHaveLength(24);

      const recent = await session.getRecentHistory(1024 * 1024);
      expect(recent.messages).toHaveLength(21);
      expect(recent.messages[0].id.startsWith("compaction_")).toBe(true);
      // m1..m3 sit before the overlay and outside the window.
      expect(recent.truncated).toBe(true);
    });
  }, 120_000);

  it("an overlay on a sibling branch is not clipped into a cut window", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      await instance.sessions.session().getCompactions();
      seed(sqlOf(instance), 1, 2000, 1000);
      const session = instance.sessions.session();
      // A branch off m1 whose row is newer than the window's first row.
      await session.appendMessage(text("b1"), { parentId: "m1" });
      await session.addCompaction("summary", "b1", "m1980");
      const recent = await session.getRecentHistory(1024 * 1024, {
        leafId: "m2000"
      });
      expect(recent.messages[0].id.startsWith("compaction_")).toBe(false);
    });
  }, 120_000);

  it("a path read costs rows on the path, not rows in the session", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      await instance.sessions.session().getCompactions();
      const sql = sqlOf(instance);
      seed(sql, 1, 20_000);
      const session = instance.sessions.session();
      const rowsRead = await rowsReadBy(sql, () =>
        session.getHistory({ leafId: "m100" })
      );
      // 100 rows on the path; before, the join scanned all 20,000.
      expect(rowsRead).toBeLessThan(2_000);
    });
  }, 120_000);
});
