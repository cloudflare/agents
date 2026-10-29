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

/** Forget every OAuth state nonce, as if each authorization link expired. */
export async function expireOAuthStates(
  storage: DurableObjectStorage
): Promise<void> {
  const keys = [...(await storage.list({ prefix: "/" })).keys()].filter((key) =>
    key.includes("/state/")
  );
  if (keys.length > 0) await storage.delete(keys);
}

/**
 * Move every recorded authorization round of a server back by `ms`, as if
 * its step-ups happened that long ago.
 */
export function ageAuthorizationRounds(
  storage: DurableObjectStorage,
  serverId: string,
  ms: number
): void {
  const [row] = storage.sql
    .exec<{ authorization_rounds: string | null }>(
      "SELECT authorization_rounds FROM cf_agents_mcp_servers WHERE id = ?",
      serverId
    )
    .toArray();
  if (!row?.authorization_rounds) {
    throw new Error(`No authorization rounds for ${serverId}`);
  }
  const rounds = JSON.parse(row.authorization_rounds) as {
    byScope: Record<string, { at: number }>;
  };
  for (const entry of Object.values(rounds.byScope)) entry.at -= ms;
  storage.sql.exec(
    "UPDATE cf_agents_mcp_servers SET authorization_rounds = ? WHERE id = ?",
    JSON.stringify(rounds),
    serverId
  );
}

/** Move when a server's pending authorization link was saved back by `ms`. */
export function ageAuthorizationLink(
  storage: DurableObjectStorage,
  serverId: string,
  ms: number
): void {
  const id = `auth-expiry:${serverId}`;
  const [row] = storage.sql
    .exec<{ payload: string }>(
      "SELECT payload FROM cf_agents_jobs WHERE capability = 'mcp' AND id = ?",
      id
    )
    .toArray();
  if (!row) throw new Error(`No link expiry job for ${serverId}`);
  const payload = JSON.parse(row.payload) as { savedAt: number };
  payload.savedAt -= ms;
  storage.sql.exec(
    "UPDATE cf_agents_jobs SET payload = ? WHERE capability = 'mcp' AND id = ?",
    JSON.stringify(payload),
    id
  );
}
