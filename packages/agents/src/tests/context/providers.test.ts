import { describe, expect, it } from "vitest";
import {
  AgentContextProvider,
  AgentSearchProvider,
  ContextBlocks,
  type SqlProvider
} from "../../context";
import { withCapabilityHarness } from "../shared/capability-harness";

/**
 * The SQLite-backed context providers own their own tables now: Sessions no
 * longer creates `cf_agents_context_blocks`, so the provider must create it
 * lazily on first use over real Durable Object SQLite.
 */

/** The tagged-template SQL surface `Agent` exposes, over real DO storage. */
class StorageSql implements SqlProvider {
  constructor(private readonly storage: DurableObjectStorage) {}

  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    return [...this.storage.sql.exec(strings.join("?"), ...values)] as T[];
  }
}

function tableNames(storage: DurableObjectStorage): string[] {
  return [
    ...storage.sql.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    )
  ].map((row) => String(row.name));
}

describe("AgentContextProvider", () => {
  it("creates its block table lazily and persists content", async () => {
    await withCapabilityHarness(async ({ storage }) => {
      const provider = new AgentContextProvider(new StorageSql(storage));
      provider.init("memory");
      expect(tableNames(storage)).not.toContain("cf_agents_context_blocks");

      expect(await provider.get()).toBeNull();
      expect(tableNames(storage)).toContain("cf_agents_context_blocks");

      await provider.set("likes Workers");
      expect(await provider.get()).toBe("likes Workers");
      await provider.set("likes Durable Objects");
      expect(await provider.get()).toBe("likes Durable Objects");

      // One row per label: a rewrite upserts rather than accumulating.
      expect(
        Number(
          storage.sql
            .exec("SELECT COUNT(*) AS count FROM cf_agents_context_blocks")
            .one().count
        )
      ).toBe(1);
    });
  });

  it("keeps separate labels in separate rows", async () => {
    await withCapabilityHarness(async ({ storage }) => {
      const sql = new StorageSql(storage);
      const soul = new AgentContextProvider(sql, "soul");
      const memory = new AgentContextProvider(sql);
      memory.init("memory");

      await soul.set("identity");
      await memory.set("facts");

      const blocks = new ContextBlocks([
        { label: "soul", provider: soul },
        { label: "memory", provider: memory }
      ]);
      await blocks.load();
      expect(blocks.getBlock("soul")?.content).toBe("identity");
      expect(blocks.getBlock("memory")?.content).toBe("facts");
    });
  });
});

describe("AgentSearchProvider", () => {
  it("indexes and searches entries through real FTS5", async () => {
    await withCapabilityHarness(async ({ storage }) => {
      const provider = new AgentSearchProvider(new StorageSql(storage));
      provider.init("knowledge");

      expect(await provider.get()).toBeNull();
      expect(tableNames(storage)).toContain("cf_agents_search_fts");

      await provider.set("readme", "Durable Objects keep state on the edge");
      await provider.set("guide", "Workers run close to the user");
      expect(await provider.get()).toBe("2 entries indexed.");

      expect(await provider.search("durable")).toContain("[readme]");
      expect(await provider.search("nothing here")).toBeNull();

      // A rewrite replaces the entry instead of duplicating it.
      await provider.set("readme", "rewritten body");
      expect(await provider.get()).toBe("2 entries indexed.");
      expect(await provider.search("durable")).toBeNull();
    });
  });

  it("does not leak entries across labels", async () => {
    await withCapabilityHarness(async ({ storage }) => {
      const sql = new StorageSql(storage);
      const docs = new AgentSearchProvider(sql);
      docs.init("docs");
      const notes = new AgentSearchProvider(sql);
      notes.init("notes");

      await docs.set("one", "shared vocabulary");
      expect(await notes.search("shared")).toBeNull();
      expect(await notes.get()).toBeNull();
      expect(await docs.search("shared")).toContain("[one]");
    });
  });
});
