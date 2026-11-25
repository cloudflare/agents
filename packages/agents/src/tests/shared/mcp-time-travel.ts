/**
 * Storage edits that stand in for time passing, for MCP integration tests:
 * expire OAuth state nonces or age step-up rounds without waiting.
 */

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
