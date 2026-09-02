import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  SessionHarnessObject,
  SessionSearchHarnessObject
} from "../capabilities/sessions";
import type { SessionMessage } from "../../sessions";

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function message(id: string, body: string, role: string): SessionMessage {
  return { id, role, parts: [{ type: "text", text: body }] };
}

function legacySchema(): string[] {
  return [
    `CREATE TABLE assistant_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      parent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    "CREATE INDEX idx_assistant_msg_parent ON assistant_messages(parent_id)",
    "CREATE INDEX idx_assistant_msg_session ON assistant_messages(session_id)",
    `CREATE TABLE assistant_compactions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      from_message_id TEXT NOT NULL,
      to_message_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE assistant_config (
      session_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (session_id, key)
    )`,
    `CREATE TABLE assistant_sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_session_id TEXT,
      model TEXT,
      source TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      estimated_cost REAL DEFAULT 0,
      end_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    "CREATE VIRTUAL TABLE assistant_fts USING fts5(id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content, tokenize='porter unicode61')"
  ];
}

function legacyRows(): string[] {
  return [
    `INSERT INTO assistant_messages
      (id, session_id, parent_id, role, content, created_at)
     VALUES ('m1', '', NULL, 'user', ${sqlLiteral(
       JSON.stringify(message("m1", "root question", "user"))
     )}, '2026-01-02 03:04:05')`,
    `INSERT INTO assistant_messages
      (id, session_id, parent_id, role, content, created_at)
     VALUES ('m2', '', 'm1', 'assistant', ${sqlLiteral(
       JSON.stringify(message("m2", "first answer", "assistant"))
     )}, '2026-01-02 03:04:06')`,
    `INSERT INTO assistant_messages
      (id, session_id, parent_id, role, content, created_at)
     VALUES ('m3', '', 'm1', 'assistant', ${sqlLiteral(
       JSON.stringify(message("m3", "second answer", "assistant"))
     )}, '2026-01-02 03:04:07')`,
    `INSERT INTO assistant_compactions
      (id, session_id, summary, from_message_id, to_message_id, created_at)
     VALUES ('c1', '', 'first branch summary', 'm1', 'm2',
       '2026-01-02 03:05:00')`,
    "INSERT INTO assistant_config (session_id, key, value) VALUES ('', 'prompt', 'frozen prompt')",
    `INSERT INTO assistant_sessions
      (id, name, parent_session_id, model, source, input_tokens,
       output_tokens, estimated_cost, end_reason, created_at, updated_at)
     VALUES ('chat-one', 'Chat one', NULL, 'model-a', 'test', 12, 8,
       0.01, 'complete', '2026-01-02 03:00:00', '2026-01-02 03:05:00')`,
    "INSERT INTO assistant_fts (id, session_id, role, content) VALUES ('m1', '', 'user', 'root question')"
  ];
}

describe("Sessions legacy migration", () => {
  it("lifts assistant tables, preserves branch order, and drops the sources", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());

    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      instance.seedLegacy([...legacySchema(), ...legacyRows()]);

      const session = instance.sessions.session();
      const active = await session.getHistory();
      expect(active.map((item) => item.id)).toEqual(["m1", "m3"]);

      const compactedBranch = await session.getHistory({ leafId: "m2" });
      expect(compactedBranch).toHaveLength(1);
      expect(compactedBranch[0].parts[0].text).toBe("first branch summary");

      expect(await session.getCompactions()).toEqual([
        {
          id: "c1",
          summary: "first branch summary",
          fromMessageId: "m1",
          toMessageId: "m2",
          createdAt: "2026-01-02T03:05:00.000Z"
        }
      ]);

      // `seq` is assigned in branch order, so `ORDER BY seq` reproduces the
      // legacy `created_at` ordering without a rowid or an index.
      expect(instance.messageRows("")).toEqual([
        { id: "m1", seq: 1, type: "message", parent_id: null },
        { id: "m2", seq: 2, type: "message", parent_id: "m1" },
        { id: "m3", seq: 3, type: "message", parent_id: "m1" }
      ]);
      expect(
        await instance.kvGet<number>("cf_agents:sessions_schema_version")
      ).toBe(1);

      // Every lifted source is dropped once its rows are verified present.
      // Keeping them would leave the object storing its history twice, and a
      // Durable Object only has 10 GB to spend.
      const tables = instance.tableNames();
      for (const name of [
        "assistant_messages",
        "assistant_compactions",
        "assistant_sessions",
        "assistant_fts"
      ]) {
        expect(tables).not.toContain(name);
        expect(tables).not.toContain(`${name}__lifted_v1`);
      }
      // `assistant_config` belongs to Think, which lifts and drops it itself.
      expect(tables).toContain("assistant_config");
      expect(instance.readLegacyConfig()).toEqual([
        { key: "prompt", value: "frozen prompt" }
      ]);
    });

    await evictDurableObject(stub);

    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const active = await instance.sessions.session().getHistory();
      expect(active.map((item) => item.id)).toEqual(["m1", "m3"]);
      expect(instance.tableNames()).not.toContain("assistant_messages");
    });
  });

  it("keeps a lifted source when a row did not copy faithfully", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());

    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      // A destination row already occupying `m2`'s key makes `INSERT OR
      // IGNORE` skip the legacy row, so the legacy payload never arrives.
      // Dropping the source here would destroy the only copy of it.
      instance.seedLegacy([
        ...legacySchema(),
        ...legacyRows(),
        `CREATE TABLE IF NOT EXISTS cf_agents_session_messages (
           session_id TEXT NOT NULL,
           id TEXT NOT NULL,
           seq INTEGER NOT NULL,
           parent_id TEXT,
           type TEXT NOT NULL DEFAULT 'message',
           role TEXT NOT NULL,
           content TEXT NOT NULL,
           content_chunks INTEGER NOT NULL DEFAULT 0,
           token_estimate INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL,
           PRIMARY KEY (session_id, id)
         ) WITHOUT ROWID`,
        `INSERT INTO cf_agents_session_messages
           (session_id, id, seq, parent_id, type, role, content, token_estimate, created_at)
         VALUES ('', 'm2', 1, NULL, 'message', 'user',
           '{"id":"m2","role":"user","parts":[{"type":"text","text":"squatter"}]}',
           0, 1)`
      ]);

      // Touch the session so the Lifecycle starts and the lift runs.
      await instance.sessions.session().getHistory();

      expect(instance.tableNames()).toContain("assistant_messages");
      expect(
        instance.eventsOfType("session:migration:incomplete")[0]?.payload
      ).toMatchObject({ table: "assistant_messages", source: 3, copied: 2 });
    });
  });

  it("lifts legacy FTS rows only when search indexing is enabled", async () => {
    const stub = env.SessionSearchHarnessObject.getByName(crypto.randomUUID());

    await runInDurableObject(
      stub,
      async (instance: SessionSearchHarnessObject) => {
        instance.seedLegacy([...legacySchema(), ...legacyRows()]);

        const session = instance.sessions.session();
        expect(
          (await session.search("root question")).map((hit) => hit.id)
        ).toEqual(["m1"]);
        expect(instance.tableNames()).not.toContain("assistant_fts");
      }
    );
  });
});
