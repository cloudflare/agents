import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import { SQLITE_ROW_BYTES } from "../internal/platform-limits";
import type { TestAlarmInitAgent } from "./agents/schedule";

/**
 * The row floor (`SQLITE_ROW_BYTES`) stays at the lowest cap of any runtime
 * the SDK runs on. The Vitest pool this repo installs holds 8 MiB rows
 * (workerd 1.20260930 or later), which the raised floor needs: this fails if
 * a pool change takes that away. See "Raising it" in design/platform-limits.md.
 */
describe("platform row cap in the test pool", () => {
  it("holds the floor and an 8 MB value", async () => {
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
      if (!holds(8_000_000)) {
        expect.fail(
          "The Vitest pool this repo installs no longer holds an 8 MB value " +
            "(its workerd is older than 1.20260930). Rows the SDK writes may not " +
            'fit: see "Raising it" in design/platform-limits.md.'
        );
      }
    });
  });
});
