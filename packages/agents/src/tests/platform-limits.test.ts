import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import { SQLITE_ROW_BYTES } from "../internal/platform-limits";
import type { TestAlarmInitAgent } from "./agents/schedule";

/**
 * The row floor (`SQLITE_ROW_BYTES`) stays at the lowest cap of any runtime
 * the SDK runs on, and the vitest pool is the lowest. This checks that cap
 * on every run. See "Raising it" in design/platform-limits.md.
 */
describe("platform row cap in the test pool", () => {
  it("holds the floor, and fails when the pool can hold 8 MB rows", async () => {
    const stub = await getAgentByName(
      env.TestAlarmInitAgent,
      crypto.randomUUID()
    );
    await runInDurableObject(stub, (_agent: TestAlarmInitAgent, state) => {
      const sql = state.storage.sql;
      const holds = (bytes: number) => {
        try {
          sql.exec("SELECT length(?) AS l", "x".repeat(bytes)).one();
          return true;
        } catch (error) {
          if (String(error).includes("SQLITE_TOOBIG")) return false;
          throw error;
        }
      };

      expect(holds(SQLITE_ROW_BYTES)).toBe(true);
      if (holds(8_000_000)) {
        expect.fail(
          "The vitest pool now holds an 8 MB value (its workerd is 1.20260930 " +
            "or later). The row floor can be raised: follow \"Raising it\" in " +
            "design/platform-limits.md, then flip this check."
        );
      }
    });
  });
});
