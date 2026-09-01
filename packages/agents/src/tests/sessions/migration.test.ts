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
  it("lifts assistant tables, preserves branch order, and leaves rollback tombstones", async () => {
    const stub = env.SessionHarnessObject.getByName(crypto.randomUUID());

    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      instance.seedLegacy([...legacySchema(), ...legacyRows()]);

      const session = instance.sessions.session();
      const active = await session.getHistory({ reconstruct: "pointer" });
      expect(active.map((item) => item.id)).toEqual(["m1", "m3"]);

      const compactedBranch = await session.getHistory({
        leafId: "m2",
        reconstruct: "pointer"
      });
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

      const sync = instance.sessions.__DO_NOT_USE_WILL_BREAK__sync();
      expect(sync.getConfigValue("", "prompt")).toBe("frozen prompt");
      expect(
        await instance.kvGet<number>("cf_agents:sessions_schema_version")
      ).toBe(1);

      const tables = instance.tableNames();
      expect(tables).toContain("assistant_messages__lifted_v1");
      expect(tables).toContain("assistant_compactions__lifted_v1");
      expect(tables).toContain("assistant_config__lifted_v1");
      expect(tables).toContain("assistant_sessions__lifted_v1");
      expect(instance.readLegacySessionTombstone()).toEqual([
        { id: "chat-one", name: "Chat one" }
      ]);
      expect(tables).toContain("assistant_fts__lifted_v1");
      expect(tables).not.toContain("assistant_messages");
      expect(tables).not.toContain("assistant_fts");
    });

    await evictDurableObject(stub);

    await runInDurableObject(stub, async (instance: SessionHarnessObject) => {
      const active = await instance.sessions.session().getHistory({
        reconstruct: "pointer"
      });
      expect(active.map((item) => item.id)).toEqual(["m1", "m3"]);
      expect(
        instance
          .tableNames()
          .filter((name) => name === "assistant_messages__lifted_v1")
      ).toHaveLength(1);
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
        expect(instance.tableNames()).toContain("assistant_fts__lifted_v1");
      }
    );
  });
});
