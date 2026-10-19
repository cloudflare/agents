import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { openPiSessionStore } from "../session-store";

// pi's own storage conformance suite, run against the session store on a
// real Durable Object's SQLite database. Each case gets a fresh object.
registerStorageConformance(
  { describe, expect, it },
  "pi session store on Durable Object SQLite",
  async (use) => {
    const stub = env.PI_STORE_TEST.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = await openPiSessionStore(state.storage);
      try {
        await use(storage);
      } finally {
        await storage.close(BACKGROUND_CONTEXT);
      }
    });
  }
);

function schemaNames(storage: DurableObjectStorage): string[] {
  return storage.sql
    .exec<{ type: string; name: string }>(
      "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
    )
    .toArray()
    .map((row) => `${row.type}:${row.name}`)
    .sort();
}

describe("pi session store", () => {
  // Objects opened by earlier releases already hold pi's data under these
  // names. If pi renames one, existing sessions would silently vanish.
  it("keeps the table and index names existing objects use", async () => {
    const stub = env.PI_STORE_TEST.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      await openPiSessionStore(state.storage);
      expect(schemaNames(state.storage)).toEqual(
        [
          "index:pi_conversations_by_owner_conversation",
          "index:pi_conversations_by_owner_task",
          "index:pi_document_revisions_by_kind",
          "index:pi_documents_by_address",
          "index:pi_documents_by_scope",
          "index:pi_documents_by_scope_kind",
          "index:pi_entries_by_conversation",
          "index:pi_entry_heads_by_conversation",
          "index:pi_submissions_by_conversation",
          "index:pi_submissions_by_request",
          "index:pi_submissions_by_status",
          "index:pi_tasks_by_abort_requested",
          "index:pi_tasks_by_background",
          "index:pi_tasks_by_conversation",
          "index:pi_tasks_by_kind",
          "index:pi_tasks_by_status",
          "table:pi_conversations",
          "table:pi_document_revisions",
          "table:pi_documents",
          "table:pi_durable_metadata",
          "table:pi_durable_schema",
          "table:pi_entries",
          "table:pi_record_ids",
          "table:pi_submissions",
          "table:pi_tasks"
        ].sort()
      );
    });
  });

  it("keeps pi's tables under its prefix", async () => {
    const stub = env.PI_STORE_TEST.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      await openPiSessionStore(state.storage, { prefix: "pi_" });
      const tables = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
        )
        .toArray()
        .map((row) => row.name);
      expect(tables.length).toBeGreaterThan(10);
      expect(tables.every((name) => name.startsWith("pi_"))).toBe(true);
      expect(tables).toContain("pi_tasks");
      expect(tables).toContain("pi_durable_schema");
    });
  });

  it("reopens an existing store without migrating again", async () => {
    const stub = env.PI_STORE_TEST.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      await openPiSessionStore(state.storage);
      await openPiSessionStore(state.storage);
      const version = state.storage.sql
        .exec<{ version: number }>("SELECT version FROM pi_durable_schema")
        .one().version;
      expect(version).toBe(2);
    });
  });

  it("rejects a prefix Durable Objects reserve", async () => {
    for (const prefix of ["_cf_x", "_CF_x"]) {
      await expect(
        openPiSessionStore({} as DurableObjectStorage, { prefix })
      ).rejects.toThrow("_cf_");
    }
  });

  it("uses another prefix when asked", async () => {
    const stub = env.PI_STORE_TEST.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      await openPiSessionStore(state.storage, { prefix: "chat_" });
      expect(schemaNames(state.storage)).toContain("table:chat_tasks");
      expect(
        schemaNames(state.storage).some((name) => name.includes(":pi_"))
      ).toBe(false);
    });
  });
});
