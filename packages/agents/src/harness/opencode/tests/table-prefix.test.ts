import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TablePrefixTestObject } from "./worker";

function fresh(): DurableObjectStub<TablePrefixTestObject> {
  return env.TABLE_PREFIX_TEST.getByName(crypto.randomUUID());
}

describe("prefixTables", () => {
  it("creates an engine's tables and indexes under the prefix", async () => {
    const stub = fresh();
    await stub.prefixed([
      "CREATE TABLE `account` (`id` text PRIMARY KEY)",
      'CREATE TABLE IF NOT EXISTS "session" (id TEXT PRIMARY KEY, account_id TEXT REFERENCES account(id))',
      "CREATE UNIQUE INDEX IF NOT EXISTS session_account_idx ON session (account_id)"
    ]);
    expect(await stub.objects()).toEqual([
      "engine_account",
      "engine_session",
      "engine_session_account_idx"
    ]);
  });

  it("resolves forward references in DDL to the prefixed table", async () => {
    const stub = fresh();
    await stub.prefixed([
      "CREATE TABLE `child` (`id` text, `parent_id` text, CONSTRAINT `fk` FOREIGN KEY (`parent_id`) REFERENCES `parent`(`id`))",
      "CREATE TABLE `parent` (`id` text PRIMARY KEY)"
    ]);
    const [child] = await stub.raw(
      "SELECT sql FROM sqlite_master WHERE name = 'engine_child'"
    );
    expect(String(child?.sql)).toContain("REFERENCES `engine_parent`");
  });

  it("reads and writes through the prefix, leaving columns named like tables alone", async () => {
    const stub = fresh();
    const rows = await stub.prefixed([
      "CREATE TABLE worktree (id TEXT)",
      'CREATE TABLE project (id TEXT, "worktree" TEXT)',
      ['INSERT INTO "project" ("id", "worktree") VALUES (?, ?)', "p1", "/w"],
      [
        'SELECT "project"."id", "worktree" FROM "project" WHERE "project"."worktree" = ?',
        "/w"
      ]
    ]);
    expect(rows).toEqual([{ id: "p1", worktree: "/w" }]);
    const [project] = await stub.raw(
      "SELECT sql FROM sqlite_master WHERE name = 'engine_project'"
    );
    expect(String(project?.sql)).toContain('"worktree" TEXT');
  });

  it("shows the engine only its own objects in sqlite_master, unprefixed", async () => {
    const stub = fresh();
    await stub.raw("CREATE TABLE host_table (id TEXT)");
    await stub.raw("CREATE TABLE session (mine TEXT)");
    const rows = await stub.prefixed([
      "CREATE TABLE session (id TEXT)",
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 1) <> '_'"
    ]);
    expect(rows).toEqual([{ name: "session" }]);
    expect(await stub.objects()).toEqual([
      "engine_session",
      "host_table",
      "session"
    ]);
  });

  it("keeps rewriting tables it created before the view was opened", async () => {
    const stub = fresh();
    await stub.raw("CREATE TABLE engine_kv (key TEXT, value TEXT)");
    const rows = await stub.prefixed([
      "INSERT INTO kv (key, value) VALUES ('a', '1')",
      "SELECT value FROM kv WHERE key = 'a'"
    ]);
    expect(rows).toEqual([{ value: "1" }]);
  });

  it("leaves string literals, common table expressions, and unknown names alone", async () => {
    const stub = fresh();
    const rows = await stub.prefixed([
      "CREATE TABLE event (id TEXT, type TEXT)",
      "INSERT INTO event (id, type) VALUES ('e1', 'event')",
      "WITH recent AS (SELECT id, type FROM event) SELECT id, type FROM recent WHERE type = 'event'"
    ]);
    expect(rows).toEqual([{ id: "e1", type: "event" }]);
  });

  it("renames and drops through the prefix", async () => {
    const stub = fresh();
    await stub.prefixed([
      "CREATE TABLE `old_name` (`id` text)",
      "ALTER TABLE `old_name` RENAME TO `new_name`",
      "CREATE TABLE gone (id TEXT)",
      "DROP TABLE IF EXISTS gone"
    ]);
    expect(await stub.objects()).toEqual(["engine_new_name"]);
  });
});
