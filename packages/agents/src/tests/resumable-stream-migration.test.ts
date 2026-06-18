import { env } from "cloudflare:workers";
import { describe, expect, it, beforeEach } from "vitest";
import { getAgentByName } from "..";

/**
 * ResumableStream lazy metadata-column migration (#1691, #1733).
 *
 * New tables are created with `message_id` / `is_continuation` up front, so
 * most wakes never migrate. Tables created by an older release lack those
 * columns and must migrate lazily — on the first stream write that needs
 * them — instead of paying a schema-introspection read on every construction.
 *
 * The recovery hinges on `isMissingMetadataColumnError` matching the SQLite
 * error text the runtime actually emits, which only a real workerd SQLite can
 * verify. These tests drive the legacy path end to end against it.
 */

interface LegacyMigrationStub {
  setupLegacyStreamTableForTest(): Promise<void>;
  resumableLegacyMigrationForTest(): Promise<{
    columnsBefore: string[];
    legacyMessageId: string | null;
    startThrew: boolean;
    columnsAfter: string[];
    newStreamMessageId: string | null;
  }>;
}

async function getAgent(name: string): Promise<LegacyMigrationStub> {
  return getAgentByName(
    env.TestSessionAgent,
    name
  ) as unknown as Promise<LegacyMigrationStub>;
}

describe("ResumableStream — legacy metadata-column migration", () => {
  let name: string;
  beforeEach(() => {
    name = `rs-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  it("migrates a legacy table on first stream write instead of throwing", async () => {
    const agent = await getAgent(name);
    await agent.setupLegacyStreamTableForTest();

    const result = await agent.resumableLegacyMigrationForTest();

    // Precondition: the seeded table really is the old schema.
    expect(result.columnsBefore).not.toContain("message_id");
    expect(result.columnsBefore).not.toContain("is_continuation");

    // Reading the new column off a legacy row is guarded → null, no throw.
    expect(result.legacyMessageId).toBeNull();

    // start() hit the missing columns, migrated, and retried successfully.
    expect(result.startThrew).toBe(false);
    expect(result.columnsAfter).toContain("message_id");
    expect(result.columnsAfter).toContain("is_continuation");

    // The migrated row round-trips the value start() wrote.
    expect(result.newStreamMessageId).toBe("msg-1");
  });
});
