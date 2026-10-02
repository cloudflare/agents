import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "../context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import {
  DurableObjectSqliteDatabase,
  openPiSessionStore
} from "../session-store";

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

describe("pi session store", () => {
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
      expect(version).toBe(1);
    });
  });

  it("runs a call made during a transaction after it, outside it", async () => {
    const stub = env.PI_STORE_TEST.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage);
      await db.exec("CREATE TABLE notes (text TEXT)");
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let opened = () => {};
      const open = new Promise<void>((resolve) => {
        opened = resolve;
      });
      const rolledBack = db.transaction(async (tx) => {
        await tx.run("INSERT INTO notes VALUES (?)", "inside");
        opened();
        await held;
        throw new Error("roll back");
      });
      await open;
      // Issued while the transaction is open: it must not join it.
      const outside = db.run("INSERT INTO notes VALUES (?)", "outside");
      const seen = db.all<{ text: string }>("SELECT text FROM notes");
      release();
      await expect(rolledBack).rejects.toThrow("roll back");
      await outside;
      expect(await seen).toEqual([{ text: "outside" }]);
    });
  });

  it("runs a statement at once when no transaction is open", async () => {
    const stub = env.PI_STORE_TEST.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage);
      await db.exec("CREATE TABLE notes (text TEXT)");
      const written = db.run("INSERT INTO notes VALUES (?)", "now");
      // Not awaited yet: the write already happened, in this tick.
      expect(
        state.storage.sql.exec("SELECT text FROM notes").toArray()
      ).toEqual([{ text: "now" }]);
      await written;
    });
  });

  it("runs calls in call order", async () => {
    const stub = env.PI_STORE_TEST.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage);
      await db.exec("CREATE TABLE notes (n INTEGER)");
      const committed = db.transaction(async (tx) => {
        await tx.run("INSERT INTO notes VALUES (?)", 1);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await tx.run("INSERT INTO notes VALUES (?)", 2);
      });
      const after = db.run("INSERT INTO notes VALUES (?)", 3);
      const read = db.all<{ n: number }>("SELECT n FROM notes ORDER BY rowid");
      await Promise.all([committed, after]);
      expect(await read).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    });
  });

  it("keeps running calls after one fails", async () => {
    const stub = env.PI_STORE_TEST.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage);
      const failed = db.run("INSERT INTO missing VALUES (1)");
      const next = db.get<{ one: number }>("SELECT 1 AS one");
      await expect(failed).rejects.toThrow();
      expect(await next).toEqual({ one: 1 });
    });
  });

  it("rejects a transaction handle used after its transaction", async () => {
    const stub = env.PI_STORE_TEST.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage);
      const escaped = await db.transaction(async (tx) => tx);
      await expect(escaped.get("SELECT 1")).rejects.toThrow("no longer active");
    });
  });

  it("rejects a prefix Durable Objects reserve", () => {
    expect(
      () =>
        new DurableObjectSqliteDatabase({} as DurableObjectStorage, {
          prefix: "_cf_x"
        })
    ).toThrow();
  });
});
