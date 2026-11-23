import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SessionHarnessObject } from "../capabilities/sessions";
import type { SessionMessage } from "../../sessions";

/**
 * Finding a session's newest row: a scan of the session until it holds
 * 3,000 rows, then a `(session_id, seq)` index created once. The answer is
 * the same either way.
 */

function sqlOf(instance: SessionHarnessObject): SqlStorage {
  // SAFETY: tests read the object's own storage.
  return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
}

function seed(sql: SqlStorage, to: number): void {
  sql.exec(
    `INSERT INTO cf_agents_session_messages
      (session_id, id, seq, parent_id, role, content, token_estimate, created_at)
     WITH RECURSIVE n(i) AS (
       SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < CAST(? AS INTEGER))
     SELECT '', 'm' || i, i, CASE WHEN i = 1 THEN NULL ELSE 'm' || (i - 1) END,
       'user', json_object('id', 'm' || i, 'role', 'user',
         'parts', json_array(json_object('type', 'text', 'text', 'x'))),
       1, i FROM n`,
    to
  );
}

function text(id: string): SessionMessage {
  return { id, role: "user", parts: [{ type: "text", text: "x" }] };
}

function hasIndex(sql: SqlStorage): boolean {
  return (
    sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'cf_agents_session_messages_by_seq'"
      )
      .toArray().length > 0
  );
}

/**
 * The newest row, computed from every row in JS: SQLite ignores `NOT
 * INDEXED` on this WITHOUT ROWID table, so only this can't use the index.
 */
function newestByScan(sql: SqlStorage): string | null {
  let newest: { id: string; seq: number } | null = null;
  for (const row of sql
    .exec<{ id: string; seq: number }>(
      "SELECT id, seq FROM cf_agents_session_messages WHERE session_id = ''"
    )
    .toArray()) {
    if (!newest || row.seq > newest.seq) newest = row;
  }
  return newest?.id ?? null;
}

async function started() {
  const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());
  await runInDurableObject(stub, (instance: SessionHarnessObject) =>
    instance.sessions.session().getCompactions()
  );
  return stub;
}

describe("Sessions tail index", () => {
  it("does not index a session below 3,000 rows", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const sql = sqlOf(instance);
      seed(sql, 2_998);
      const session = instance.sessions.session();
      await session.appendMessage(text("m2999"));
      expect((await session.getLatestLeaf())?.id).toBe("m2999");
      expect(hasIndex(sql)).toBe(false);
    });
  });

  it("indexes the table once a session reaches 3,000 rows and finds the tail in one row", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const sql = sqlOf(instance);
      seed(sql, 3_000);
      const session = instance.sessions.session();
      expect((await session.getLatestLeaf())?.id).toBe("m3000");
      expect(hasIndex(sql)).toBe(true);
      const plan = sql
        .exec<{ detail: string }>(
          `EXPLAIN QUERY PLAN SELECT id, seq FROM cf_agents_session_messages
           WHERE session_id = '' ORDER BY seq DESC LIMIT 1`
        )
        .toArray()
        .map((row) => row.detail)
        .join(" ");
      expect(plan).toContain("cf_agents_session_messages_by_seq");

      // A delete drops the cached tail; the next lookup uses the index.
      await session.deleteMessages(["m3000"]);
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
      let leaf: string | undefined;
      try {
        leaf = (await session.getLatestLeaf())?.id;
      } finally {
        (sql as { exec: SqlStorage["exec"] }).exec = exec;
      }
      expect(leaf).toBe("m2999");
      // The tail, then the leaf's content: a handful of rows, not 6,000.
      expect(cursors.reduce((sum, c) => sum + c.rowsRead, 0)).toBeLessThan(10);
    });
  });

  it("indexes when appends take a warm session to 3,000 rows", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const sql = sqlOf(instance);
      seed(sql, 2_998);
      const session = instance.sessions.session();
      await session.getLatestLeaf();
      await session.appendMessage(text("m2999"));
      expect(hasIndex(sql)).toBe(false);
      await session.appendMessage(text("m3000"));
      expect(hasIndex(sql)).toBe(true);
    });
  });

  it("does not count rows on a cold lookup below 3,000", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const sql = sqlOf(instance);
      seed(sql, 2_995);
      const scan = sql.exec(
        "SELECT id, seq FROM cf_agents_session_messages WHERE session_id = '' ORDER BY seq DESC LIMIT 1"
      );
      scan.toArray();
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
        await instance.sessions.session().getLatestLeaf();
      } finally {
        (sql as { exec: SqlStorage["exec"] }).exec = exec;
      }
      // The scan for the newest row, then the leaf's content.
      expect(cursors.reduce((sum, c) => sum + c.rowsRead, 0)).toBeLessThan(
        scan.rowsRead + 10
      );
    });
  });

  it("keeps appending in order when the index can't be built", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const sql = sqlOf(instance);
      // A table holding the index's name makes CREATE INDEX fail.
      sql.exec("CREATE TABLE cf_agents_session_messages_by_seq (x)");
      seed(sql, 2_998);
      const session = instance.sessions.session();
      await session.getLatestLeaf();
      await session.appendMessage(text("m2999"));
      await session.appendMessage(text("m3000"));
      // A failed build isn't retried, and the rows aren't counted again.
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
        await session.appendMessage(text("m3001"));
      } finally {
        (sql as { exec: SqlStorage["exec"] }).exec = exec;
      }
      expect(cursors.reduce((sum, c) => sum + c.rowsRead, 0)).toBeLessThan(100);
      const history = await session.getHistory();
      expect(history).toHaveLength(3_001);
      expect(history.slice(-3).map((m) => m.id)).toEqual([
        "m2999",
        "m3000",
        "m3001"
      ]);
    });
  });

  it("counts stored rows, not the newest seq, so a trimmed session stays unindexed", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const sql = sqlOf(instance);
      // 100 rows left after retention trimmed the oldest: seq 3,401-3,500.
      sql.exec(
        `INSERT INTO cf_agents_session_messages
          (session_id, id, seq, parent_id, role, content, token_estimate, created_at)
         WITH RECURSIVE n(i) AS (SELECT 3401 UNION ALL SELECT i + 1 FROM n WHERE i < 3500)
         SELECT '', 'm' || i, i, CASE WHEN i = 3401 THEN NULL ELSE 'm' || (i - 1) END,
           'user', json_object('id', 'm' || i, 'role', 'user',
             'parts', json_array(json_object('type', 'text', 'text', 'x'))),
           1, i FROM n`
      );
      const session = instance.sessions.session();
      expect((await session.getLatestLeaf())?.id).toBe("m3500");
      await session.appendMessage(text("m3501"));
      expect(hasIndex(sql)).toBe(false);
    });
  });

  it("gives the same newest row with the index as a scan, over appends, branches and deletes", async () => {
    const stub = await started();
    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const sql = sqlOf(instance);
      seed(sql, 3_000);
      const session = instance.sessions.session();
      await session.getLatestLeaf();
      expect(hasIndex(sql)).toBe(true);
      let state = 7;
      const random = (n: number) => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state % n;
      };
      let counter = 0;
      for (let step = 0; step < 120; step++) {
        const ids = sql
          .exec<{ id: string }>(
            "SELECT id FROM cf_agents_session_messages WHERE session_id = '' ORDER BY seq DESC LIMIT 20"
          )
          .toArray()
          .map((row) => row.id);
        const roll = random(10);
        if (roll < 5) {
          await session.appendMessage(text(`n${counter++}`));
        } else if (roll < 7) {
          await session.appendMessage(text(`n${counter++}`), {
            parentId: ids[random(ids.length)]
          });
        } else if (roll < 9) {
          // The newest row, or one near it.
          await session.deleteMessages([ids[random(3)]]);
        } else {
          await session.deleteMessages([ids[0], ids[1]]);
        }
        expect((await session.getLatestLeaf())?.id, `step ${step}`).toBe(
          newestByScan(sql)
        );
      }
    });
  }, 120_000);
});
