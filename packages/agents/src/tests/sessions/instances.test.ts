import { describe, expect, it } from "vitest";
import { Context } from "../../context";
import { Sessions } from "../../sessions";
import { capabilityStore } from "../../lifecycle/capability";
import { sessionTables } from "../../sessions/core";
import type { SessionMessage } from "../../sessions";
import { withCapabilityHarness } from "../shared/capability-harness";
import { describeInstanceConformance } from "../shared/instance-conformance";

/**
 * More than one Sessions in one object (INSTANCES.md, I3): a named instance
 * has its own tables, index and schema key; the default keeps today's.
 */

function text(id: string, body = id): SessionMessage {
  return { id, role: "user", parts: [{ type: "text", text: body }] };
}

function image(id: string): SessionMessage {
  return {
    id,
    role: "user",
    parts: [
      { type: "text", text: "see attached" },
      {
        type: "file",
        mediaType: "image/png",
        filename: "pic.png",
        url: `data:image/png;base64,${btoa("p".repeat(1_200_000))}`
      }
    ]
  };
}

describe("Sessions instances", () => {
  describeInstanceConformance({
    kind: "sessions",
    make: (name) => new Sessions({ name }),
    smoke: async (sessions) => {
      const session = sessions.session();
      await session.appendMessage(text("m1", "hello world"));
      await session.appendMessage(image("m2"));
      await session.appendMessage(text("m3", "bye"));
      await session.addCompaction("summary", "m1", "m2");
      await session.internal_setConfig("transcript:k", "v");
      await session.internal_setAnnotation("ctx", "m3", "a");
      await session.search("hello");
    }
  });

  it("keeps the default instance on the tables every release used", () => {
    // What Sessions builds from its store: the default's statement text is
    // built from these, so it is byte for byte the text before instances.
    expect(sessionTables(capabilityStore("sessions", undefined).table)).toEqual(
      {
        messages: "cf_agents_session_messages",
        chunks: "cf_agents_session_message_chunks",
        compactions: "cf_agents_session_compactions",
        compactionsRebuild: "cf_agents_session_compactions_v2",
        config: "cf_agents_session_config",
        annotations: "cf_agents_session_annotations",
        fts: "cf_agents_session_fts",
        attachmentMeta: "cf_agents_session_attachment_meta",
        attachmentChunks: "cf_agents_session_attachment_chunks",
        attachmentRefs: "cf_agents_session_attachment_refs",
        tailIndex: "cf_agents_session_messages_by_seq",
        contextBlocks: "cf_agents_context_blocks"
      }
    );
    expect(
      sessionTables(capabilityStore("sessions/audit", "audit").table, true).fts
    ).toBe("cf_agents_session_fts__n_audit_search");
  });

  it("keeps the search indexes of instances whose names extend each other apart", async () => {
    // FTS5's shadow table of `audit` (`..._content`) would otherwise be the
    // index of `audit-content`.
    await withCapabilityHarness(async ({ install }) => {
      const audit = new Sessions({ name: "audit" });
      const content = new Sessions({ name: "audit-content" });
      const { lifecycle } = install(audit);
      lifecycle.use(content);
      await lifecycle.start();
      await audit.session().appendMessage(text("a1", "apples"));
      await content.session().appendMessage(text("c1", "cherries"));
      expect((await audit.session().search("apples")).length).toBe(1);
      expect((await content.session().search("cherries")).length).toBe(1);
      expect((await content.session().search("apples")).length).toBe(0);
    });
  });

  it("keeps two instances' transcripts, search, compactions, config and attachments apart", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const plain = new Sessions();
      const audit = new Sessions({ name: "audit" });
      const { lifecycle } = install(plain);
      lifecycle.use(audit);
      await lifecycle.start();
      const a = plain.session();
      const b = audit.session();

      // The same ids in the same session id, with different content.
      await a.appendMessage(text("m1", "apples"));
      await b.appendMessage(text("m1", "bananas"));
      await a.appendMessage(image("pic"));
      await b.appendMessage(image("pic"));
      await b.appendMessage(text("m2", "cherries"));
      expect((await a.getHistory()).map((m) => m.id)).toEqual(["m1", "pic"]);
      expect((await b.getHistory()).map((m) => m.id)).toEqual([
        "m1",
        "pic",
        "m2"
      ]);

      expect((await a.search("bananas")).length).toBe(0);
      expect((await b.search("bananas")).map((hit) => hit.id)).toEqual(["m1"]);

      await b.addCompaction("summary", "m1", "pic");
      expect(await a.getCompactions()).toEqual([]);
      expect((await b.getCompactions()).length).toBe(1);

      await a.internal_setConfig("transcript:k", "plain");
      expect(await b.internal_config("transcript:k")).toBeNull();

      // The same image (the same hash) in both; deleted in one, the other
      // still reads it.
      await b.deleteMessages(["pic"]);
      const kept = await a.getMessage("pic");
      expect((kept?.parts[1] as { url?: string } | undefined)?.url).toBe(
        (image("pic").parts[1] as { url: string }).url
      );
    });
  });

  it("keeps Context's blocks with the Sessions it is given", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const plain = new Sessions();
      const audit = new Sessions({ name: "audit" });
      const { lifecycle } = install(plain);
      lifecycle.use(audit);
      await lifecycle.start();
      const sql = {
        sql: <T>(
          strings: TemplateStringsArray,
          ...values: (string | number | boolean | null)[]
        ) => [...storage.sql.exec(strings.join("?"), ...values)] as T[]
      };
      for (const [sessions, fact] of [
        [plain, "plain fact"],
        [audit, "audit fact"]
      ] as const) {
        const context = new Context(sessions.session(), {
          sql,
          blocks: [{ label: "memory", description: "Learned facts" }]
        });
        await context.load();
        await context.setBlock("memory", fact);
      }
      const read = (table: string) =>
        storage.sql
          .exec<{ content: string }>(`SELECT content FROM ${table}`)
          .toArray()
          .map((row) => row.content);
      expect(read("cf_agents_context_blocks")).toEqual(["plain fact"]);
      expect(read("cf_agents_context_blocks__n_audit")).toEqual(["audit fact"]);
    });
  });

  it("starts without reading sqlite_master or pragma_table_info", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const sessions = new Sessions();
      const { lifecycle } = install(sessions);
      const exec = storage.sql.exec.bind(storage.sql);
      const queries: string[] = [];
      (storage.sql as { exec: SqlStorage["exec"] }).exec = ((
        query: string,
        ...params: unknown[]
      ) => {
        queries.push(query);
        return exec(query, ...(params as never[]));
        // SAFETY: forwards every argument and the cursor unchanged.
      }) as SqlStorage["exec"];
      try {
        await lifecycle.start();
        await sessions.session().appendMessage(text("m1"));
      } finally {
        (storage.sql as { exec: SqlStorage["exec"] }).exec = exec;
      }
      expect(
        queries.filter((query) => /sqlite_master|pragma_table_info/.test(query))
      ).toEqual([]);
    });
  });

  it("starts a named instance at the current schema version, with nothing to lift", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      // Legacy tables a named instance must leave to the default.
      storage.sql.exec(
        "CREATE TABLE assistant_messages (id TEXT PRIMARY KEY, session_id TEXT, parent_id TEXT, role TEXT, content TEXT, created_at TEXT)"
      );
      const audit = new Sessions({ name: "audit" });
      const { lifecycle } = install(audit);
      await lifecycle.start();
      // On the one schema record, under the instance's id; nothing for the
      // default instance.
      const record = storage.kv.get<Record<string, number>>(
        "cf_agents:schema_versions"
      );
      expect(record?.["sessions/audit"]).toBe(2);
      expect(record?.sessions).toBeUndefined();
      const tables = storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assistant_messages'"
        )
        .toArray();
      expect(tables.length).toBe(1);
    });
  });

  it("gives a named instance its own tail index", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const audit = new Sessions({ name: "audit" });
      const { lifecycle } = install(audit);
      await lifecycle.start();
      storage.sql.exec(
        `INSERT INTO cf_agents_session_messages__n_audit
          (session_id, id, seq, parent_id, role, content, token_estimate, created_at)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
         SELECT '', 'm' || i, i, CASE WHEN i = 1 THEN NULL ELSE 'm' || (i - 1) END,
           'user', json_object('id', 'm' || i, 'role', 'user',
             'parts', json_array(json_object('type', 'text', 'text', 'x'))),
           1, i FROM n`
      );
      expect((await audit.session().getLatestLeaf())?.id).toBe("m3000");
      const indexes = storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'cf_agents_session_messages_by_seq%'"
        )
        .toArray()
        .map((row) => row.name);
      expect(indexes).toEqual(["cf_agents_session_messages_by_seq__n_audit"]);
    });
  });
});
