import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import { SqlError } from "../sql-error";
import type { TestAlarmInitAgent } from "./agents/schedule";

describe("SqlError", () => {
  it("says what limit a too-large row hit and what to do", async () => {
    const stub = await getAgentByName(
      env.TestAlarmInitAgent,
      crypto.randomUUID()
    );
    await runInDurableObject(stub, async (agent: TestAlarmInitAgent) => {
      agent.sql`CREATE TABLE IF NOT EXISTS big (v TEXT)`;
      // Over the 2.2 MB cap of the workerd the test pool runs.
      const value = "x".repeat(3_000_000);
      let error: unknown;
      try {
        agent.sql`INSERT INTO big (v) VALUES (${value})`;
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SqlError);
      const message = (error as Error).message;
      expect(message).toContain("SQLITE_TOOBIG");
      expect(message).toContain("8 MiB in production");
      expect(message).toContain("Upgrade an older local runtime");
    });
  });

  it("says a statement is too long, not a row", () => {
    const error = new SqlError(
      "SELECT ...",
      new Error("statement too long: SQLITE_TOOBIG")
    );
    expect(error.message).toContain("at most 100,000 bytes");
    expect(error.message).not.toContain("8 MiB");
  });

  it("leaves other errors as they were", () => {
    expect(new SqlError("q", new Error("no such table: t")).message).toBe(
      "SQL query failed: no such table: t"
    );
  });
});
