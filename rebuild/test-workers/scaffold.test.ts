import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("workerd rig", () => {
  it("reaches a SQLite-backed DO and its synchronous storage APIs", async () => {
    const stub = env.SCAFFOLD_AGENT.get(env.SCAFFOLD_AGENT.idFromName("smoke"));
    const response = await stub.fetch("https://do/");
    expect(await response.text()).toBe("scaffold");

    await runInDurableObject(stub, (_instance, state) => {
      const rows = [...state.storage.sql.exec("SELECT 1 AS one")];
      expect(rows[0]?.one).toBe(1);
      // Presence probe for the sync KV API — W1's primary substrate candidate
      // (audit 27 §2). If this ever fails, W1 falls back to the sql table.
      const kv = (state.storage as { kv?: { put?: unknown } }).kv;
      expect(typeof kv?.put).toBe("function");
    });
  });
});
