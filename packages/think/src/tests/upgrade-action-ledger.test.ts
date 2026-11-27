import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

/**
 * Upgrade tests: the action-ledger effect rows think@0.24.0 (8d8acd0dd)
 * left in `cf_think_action_ledger`, written exactly as that release wrote
 * them into an object the current code has never started. An effect that
 * ran is not run again after the upgrade, and one cut off mid-run runs at
 * most once more. Public behaviour only, so they run on Think and on the
 * harness-backed Think alike.
 */

/** 0.24's input hash (`stableStringify` / `stableHash` in its think.ts). */
function stableStringify024(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return `${value.toString()}n`;
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify024(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify024(record[key])}`)
    .join(",")}}`;
}

function stableHash024(value: unknown): string {
  const input = stableStringify024(value);
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [h1, h2, h3, h4]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/** The echo action's input, as the test model calls it. */
const ECHO_INPUT = { message: "hello" };
const KEY = "action:echo:legacy-key";

/**
 * Write one ledger row as 0.24 left it into a fresh object, then end the
 * isolate, so the next request starts the current code over it.
 */
async function seedLedgerRow(
  name: string,
  row: {
    status: "pending" | "settled";
    output?: unknown;
    updatedAgoMs: number;
  }
): Promise<void> {
  const stub = env.ThinkToolsTestAgent.get(
    env.ThinkToolsTestAgent.idFromName(name)
  );
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS cf_think_action_ledger (
        key TEXT PRIMARY KEY,
        action_name TEXT NOT NULL,
        request_id TEXT,
        tool_call_id TEXT,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    sql.exec(`
      CREATE INDEX IF NOT EXISTS cf_think_action_ledger_sweep
      ON cf_think_action_ledger (status, updated_at)`);
    const now = Date.now();
    sql.exec(
      `INSERT INTO cf_think_action_ledger (
         key, action_name, request_id, tool_call_id, input_hash, status,
         result_json, created_at, updated_at
       ) VALUES (?, 'echo', 'req-024', 'tc-024', ?, ?, ?, ?, ?)`,
      KEY,
      stableHash024(ECHO_INPUT),
      row.status,
      row.status === "settled"
        ? JSON.stringify({
            valuePresent: row.output !== undefined,
            value: row.output
          })
        : null,
      now - row.updatedAgoMs - 1_000,
      now - row.updatedAgoMs
    );
  });
  await runInDurableObject(stub, (_instance, state) => {
    try {
      state.abort("upgrade");
    } catch {
      // The abort ends this isolate; the next request starts a new one.
    }
  }).catch(() => undefined);
}

/** Start the object with the keyed echo action. */
async function upgraded(name: string) {
  const agent = await getAgentByName(env.ThinkToolsTestAgent, name);
  await agent.useEchoActionForTest("ledger-key");
  await agent.setActionIdempotencyKey("legacy-key");
  return agent;
}

/** The output of the latest echo call in the transcript. */
async function lastEchoOutput(
  agent: Awaited<ReturnType<typeof upgraded>>
): Promise<unknown> {
  const parts = ((await agent.getStoredMessages()) as UIMessage[])
    .flatMap((message) => message.parts)
    .filter((part) => "toolCallId" in part) as Array<{ output?: unknown }>;
  return parts.at(-1)?.output;
}

describe("action-ledger rows think@0.24.0 left, after the upgrade", () => {
  it("replays an effect it ran, without running it again", async () => {
    const name = `upgrade-ledger-settled-${crypto.randomUUID()}`;
    await seedLedgerRow(name, {
      status: "settled",
      output: "from before the upgrade",
      updatedAgoMs: 1_000
    });
    const agent = await upgraded(name);

    expect((await agent.testChat("call echo action")).done).toBe(true);
    expect(await lastEchoOutput(agent)).toBe("from before the upgrade");
    expect((await agent.getActionProbe()).count).toBe(0);
  });

  it("runs an effect it left cut off once, past its lease, and not twice", async () => {
    const name = `upgrade-ledger-cut-${crypto.randomUUID()}`;
    // Cut off ten minutes ago: past the default five-minute lease.
    await seedLedgerRow(name, { status: "pending", updatedAgoMs: 600_000 });
    const agent = await upgraded(name);

    expect((await agent.testChat("call echo action")).done).toBe(true);
    expect((await agent.getActionProbe()).count).toBe(1);
    expect((await agent.testChat("call echo action again")).done).toBe(true);
    expect((await agent.getActionProbe()).count).toBe(1);
  });

  it("does not run an effect it left cut off while its lease holds", async () => {
    const name = `upgrade-ledger-held-${crypto.randomUUID()}`;
    await seedLedgerRow(name, { status: "pending", updatedAgoMs: 1_000 });
    const agent = await upgraded(name);

    expect((await agent.testChat("call echo action")).done).toBe(true);
    expect((await agent.getActionProbe()).count).toBe(0);
    // Held by the lease, not failed for another reason.
    const after = await agent.getAfterToolCallLog();
    expect(
      (
        JSON.parse(after.at(-1)?.outputJson ?? "null") as {
          error?: { name?: string };
        } | null
      )?.error?.name
    ).toBe("ActionPendingError");
  });
});
