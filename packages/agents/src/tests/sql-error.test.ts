import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import { SQLITE_ROW_BYTES } from "../internal/platform-limits";
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
      // Over every runtime's row cap (8,388,637 bytes is the largest measured).
      const value = "x".repeat(9_000_000);
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
      expect(message).toContain("SQLITE_TOOBIG. A row");
      expect(message).toContain(
        `${SQLITE_ROW_BYTES.toLocaleString("en-US")} bytes`
      );
    });
  });

  it("says a statement is too long, not a row", async () => {
    const stub = await getAgentByName(
      env.TestAlarmInitAgent,
      crypto.randomUUID()
    );
    await runInDurableObject(stub, async (agent: TestAlarmInitAgent) => {
      // A literal past the 100,000-byte statement cap, through Agent.sql.
      const query = `SELECT '${"x".repeat(100_100)}'`;
      const strings = Object.assign([query], { raw: [query] });
      let error: unknown;
      try {
        agent.sql(strings as unknown as TemplateStringsArray);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SqlError);
      const message = (error as Error).message;
      expect(message).toContain("statement too long");
      expect(message).toContain("at most 100,000 bytes");
      expect(message).not.toContain("8 MiB");
    });
  });

  it("adds no size hint to an error that only quotes the words", () => {
    expect(
      new SqlError("q", new Error('near "statement too long": syntax error'))
        .message
    ).toBe('SQL query failed: near "statement too long": syntax error');
  });

  it("leaves other errors as they were", () => {
    expect(new SqlError("q", new Error("no such table: t")).message).toBe(
      "SQL query failed: no such table: t"
    );
  });
});
