import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import type { UIMessage } from "ai";
import { isChunkTooLargeToStore, storedChunkBytes } from "../chat/chunk-size";
import { byteLength, enforceRowSizeLimit } from "../chat/sanitize";
import {
  REPLAY_CHUNK_BYTES,
  ROW_MAX_BYTES,
  ROW_PIECE_UNITS,
  ROW_VALUE_BYTES,
  SQLITE_ROW_BYTES
} from "../internal/platform-limits";
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

/** Worst-case rows at each budget, written to real SQLite in the pool. */
describe("row budgets fit one row", () => {
  const withSql = async (fn: (sql: SqlStorage) => void) => {
    const stub = await getAgentByName(
      env.TestAlarmInitAgent,
      crypto.randomUUID()
    );
    await runInDurableObject(stub, (_agent: TestAlarmInitAgent, state) =>
      fn(state.storage.sql)
    );
  };

  it("stores a ROW_VALUE_BYTES value beside small columns", async () => {
    await withSql((sql) => {
      // The shape of a Streams block or a Sessions continuation row.
      sql.exec(
        "CREATE TABLE block (stream_id TEXT, block INTEGER, seq_from INTEGER, seq_to INTEGER, body TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY (stream_id, block))"
      );
      sql.exec(
        "INSERT INTO block VALUES (?, 0, 0, 1, ?, ?, ?)",
        "s".repeat(256),
        "x".repeat(ROW_VALUE_BYTES),
        Date.now(),
        Date.now()
      );
      expect(sql.exec("SELECT length(body) AS l FROM block").one().l).toBe(
        ROW_VALUE_BYTES
      );
    });
  });

  it("stores ROW_PIECE_UNITS of the widest UTF-8 beside 400 KB of other columns", async () => {
    await withSql((sql) => {
      sql.exec("CREATE TABLE piece (id TEXT, data TEXT, other TEXT)");
      // Each "€" is one UTF-16 unit and three UTF-8 bytes.
      sql.exec(
        "INSERT INTO piece VALUES ('p', ?, ?)",
        "€".repeat(ROW_PIECE_UNITS),
        "o".repeat(400_000)
      );
      expect(sql.exec("SELECT length(data) AS l FROM piece").one().l).toBe(
        ROW_PIECE_UNITS
      );
    });
  });

  it("keeps a message at ROW_MAX_BYTES whole and compacts one byte more", async () => {
    const message = (size: number): UIMessage => {
      const empty = {
        id: "m",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "" }]
      };
      const overhead = byteLength(JSON.stringify(empty));
      return {
        ...empty,
        parts: [{ type: "text", text: "x".repeat(size - overhead) }]
      };
    };
    const atLimit = message(ROW_MAX_BYTES);
    expect(byteLength(JSON.stringify(atLimit))).toBe(ROW_MAX_BYTES);
    expect(enforceRowSizeLimit(atLimit)).toBe(atLimit);
    const over = enforceRowSizeLimit(message(ROW_MAX_BYTES + 1));
    expect(byteLength(JSON.stringify(over))).toBeLessThanOrEqual(ROW_MAX_BYTES);
    await withSql((sql) => {
      sql.exec(
        "CREATE TABLE msg (id TEXT, session_id TEXT, content TEXT, created_at INTEGER)"
      );
      sql.exec(
        "INSERT INTO msg VALUES ('m', 's', ?, ?)",
        JSON.stringify(atLimit),
        Date.now()
      );
    });
  });

  it("stores a chat chunk body at REPLAY_CHUNK_BYTES and leaves one byte more out of replay", () => {
    const body = (stored: number) => "x".repeat(stored - 2);
    expect(storedChunkBytes(body(REPLAY_CHUNK_BYTES))).toBe(REPLAY_CHUNK_BYTES);
    expect(isChunkTooLargeToStore(body(REPLAY_CHUNK_BYTES))).toBe(false);
    expect(isChunkTooLargeToStore(body(REPLAY_CHUNK_BYTES + 1))).toBe(true);
  });
});
