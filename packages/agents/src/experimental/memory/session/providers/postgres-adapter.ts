/**
 * Postgres connection adapter.
 *
 * Lets the Postgres-backed providers accept either:
 *   - a raw `pg.Client` (or any client with a compatible `query` method), or
 *   - the internal `PostgresConnection` interface used by tests and custom drivers.
 *
 * When a `pg`-style client is passed, `?` placeholders are rewritten to
 * `$1, $2, ...` on the way through, so the providers can keep using the
 * portable `?` syntax internally without users having to write a wrapper.
 */

/**
 * Minimal connection interface used internally by the Postgres providers.
 * Tests and custom drivers can implement this directly.
 */
export interface PostgresConnection {
  execute(
    query: string,
    args?: (string | number | boolean | null)[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Structural type matching `pg.Client` (and most `pg`-compatible pools).
 * Accepts the subset of the real client that the providers need, so users
 * can pass `new pg.Client({ connectionString: env.HYPERDRIVE.connectionString })`
 * directly without a wrapper.
 */
export interface PgClientLike {
  query(
    queryText: string,
    values?: readonly unknown[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Accepted client type across the Postgres providers.
 *
 * Use `pg.Client` (the recommended path for Hyperdrive):
 * ```ts
 * const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
 * await client.connect();
 * new PostgresSessionProvider(client, sessionId);
 * ```
 *
 * Or implement `PostgresConnection` for tests / bespoke drivers.
 */
export type PostgresClient = PostgresConnection | PgClientLike;

function isPostgresConnection(
  client: PostgresClient
): client is PostgresConnection {
  return typeof (client as PostgresConnection).execute === "function";
}

/**
 * Normalise an incoming client into a `PostgresConnection`. When given a
 * `pg`-style client we translate `?` placeholders to `$1, $2, ...` so the
 * providers can keep using the portable `?` syntax internally.
 */
export function toPostgresConnection(
  client: PostgresClient
): PostgresConnection {
  if (isPostgresConnection(client)) return client;

  const pg = client as PgClientLike;
  return {
    async execute(query, args) {
      let idx = 0;
      const pgQuery = query.replace(/\?/g, () => `$${++idx}`);
      const result = await pg.query(pgQuery, args ?? []);
      return { rows: result.rows };
    }
  };
}
