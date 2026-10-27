/**
 * Storage edits that stand in for time passing, for MCP integration tests.
 * Lifecycle jobs and OAuth state nonces are durable rows; moving their
 * timestamps lets a test run the next alarm or expire a link without waiting.
 */

/** A job payload as stored: a flat JSON object. */
export type McpJobPayload = Record<string, string | number | boolean | null>;

export type McpJobRow = {
  id: string;
  fn: string;
  time: number;
  payload: McpJobPayload | null;
};

/** The MCP manager's queued jobs, soonest first. */
export function mcpJobs(storage: DurableObjectStorage): McpJobRow[] {
  return storage.sql
    .exec<{ id: string; fn: string; time: number; payload: string | null }>(
      "SELECT id, fn, time, payload FROM cf_agents_jobs WHERE capability = 'mcp' ORDER BY time"
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      fn: row.fn,
      time: row.time,
      payload: row.payload ? (JSON.parse(row.payload) as McpJobPayload) : null
    }));
}

/** Make every queued MCP job due now. */
export function backdateMcpJobs(storage: DurableObjectStorage): void {
  storage.sql.exec(
    "UPDATE cf_agents_jobs SET time = ? WHERE capability = 'mcp'",
    Date.now() - 1
  );
}

/**
 * Move the start of a server's current run of reconnect failures back by
 * `ms`, as if it had been failing that long.
 */
export function ageReconnectFailures(
  storage: DurableObjectStorage,
  serverId: string,
  ms: number
): void {
  const id = `connect:${serverId}`;
  const [row] = storage.sql
    .exec<{ payload: string }>(
      "SELECT payload FROM cf_agents_jobs WHERE capability = 'mcp' AND id = ?",
      id
    )
    .toArray();
  if (!row) throw new Error(`No reconnect job for ${serverId}`);
  const payload = JSON.parse(row.payload) as { firstFailureAt: number };
  payload.firstFailureAt -= ms;
  storage.sql.exec(
    "UPDATE cf_agents_jobs SET payload = ? WHERE capability = 'mcp' AND id = ?",
    JSON.stringify(payload),
    id
  );
}

/** Forget every OAuth state nonce, as if each authorization link expired. */
export async function expireOAuthStates(
  storage: DurableObjectStorage
): Promise<void> {
  const keys = [...(await storage.list({ prefix: "/" })).keys()].filter((key) =>
    key.includes("/state/")
  );
  if (keys.length > 0) await storage.delete(keys);
}
