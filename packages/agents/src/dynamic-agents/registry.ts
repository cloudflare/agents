import type { AgentPathStep } from "../sub-routing";
import {
  pathV2IdentityName,
  sha256Hex,
  SUB_AGENT_IDENTITY_VERSION_LEGACY,
  SUB_AGENT_IDENTITY_VERSION_PATH_V2,
  type SubAgentIdentityVersion
} from "./identity";

/**
 * SQL access the registry needs from its owning Agent: the tagged
 * template helper plus raw DDL execution (for additive column
 * migrations whose errors must be inspected).
 */
export type DynamicAgentRegistrySqlHost = {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
  execRawSql(sql: string): void;
};

/**
 * The parent-side registry of spawned dynamic agents (facets), stored
 * in the parent's own SQLite. Backs `hasSubAgent` / `listSubAgents`
 * and the identity-versioning decision (legacy bare-name facets vs
 * path-scoped v2 identities).
 *
 * Table and column names are storage-frozen — never rename them.
 */
export class DynamicAgentRegistry {
  #host: DynamicAgentRegistrySqlHost;
  #ready = false;

  constructor(host: DynamicAgentRegistrySqlHost) {
    this.#host = host;
  }

  #addColumnIfNotExists(sql: string): void {
    try {
      this.#host.execRawSql(sql);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!message.toLowerCase().includes("duplicate column")) {
        throw e;
      }
    }
  }

  ensure(): void {
    if (this.#ready) return;
    // This registry is lazy because older agents may never create sub-agents.
    // Keep its additive column migrations here instead of the global schema
    // gate so first sub-agent access upgrades legacy registry tables in place.
    this.#host.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_sub_agents (
        class TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        identity_version TEXT,
        identity_name TEXT,
        PRIMARY KEY (class, name)
      )
    `;
    this.#addColumnIfNotExists(
      "ALTER TABLE cf_agents_sub_agents ADD COLUMN identity_version TEXT"
    );
    this.#addColumnIfNotExists(
      "ALTER TABLE cf_agents_sub_agents ADD COLUMN identity_name TEXT"
    );
    this.#ready = true;
  }

  record(
    className: string,
    name: string,
    identity: { version: SubAgentIdentityVersion; name: string }
  ): void {
    this.ensure();
    this.#host.sql`
      INSERT OR IGNORE INTO cf_agents_sub_agents
        (class, name, created_at, identity_version, identity_name)
      VALUES
        (${className}, ${name}, ${Date.now()}, ${identity.version}, ${identity.name})
    `;
  }

  row(
    className: string,
    name: string
  ): {
    identity_version: string | null;
    identity_name: string | null;
  } | null {
    this.ensure();
    const rows = this.#host.sql<{
      identity_version: string | null;
      identity_name: string | null;
    }>`
      SELECT identity_version, identity_name
      FROM cf_agents_sub_agents
      WHERE class = ${className} AND name = ${name}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async identity(
    className: string,
    name: string,
    childPath: ReadonlyArray<AgentPathStep>
  ): Promise<{
    version: SubAgentIdentityVersion;
    name: string;
    existing: boolean;
  }> {
    const row = this.row(className, name);
    if (row) {
      if (
        row.identity_version === SUB_AGENT_IDENTITY_VERSION_PATH_V2 &&
        typeof row.identity_name === "string"
      ) {
        return {
          version: SUB_AGENT_IDENTITY_VERSION_PATH_V2,
          name: row.identity_name,
          existing: true
        };
      }
      return {
        version: SUB_AGENT_IDENTITY_VERSION_LEGACY,
        name,
        existing: true
      };
    }

    // Do not probe the legacy bare-name facet here. `ctx.facets.get()` is
    // create-on-access, so probing would create or wake legacy storage as a
    // side effect and could reintroduce old id collisions. Existing registry
    // rows remain the compatibility signal; new rows use path-v2.
    const digest = await sha256Hex(JSON.stringify(childPath));
    return {
      version: SUB_AGENT_IDENTITY_VERSION_PATH_V2,
      name: pathV2IdentityName(name, digest),
      existing: false
    };
  }

  forget(className: string, name: string): void {
    this.ensure();
    this.#host.sql`
      DELETE FROM cf_agents_sub_agents
      WHERE class = ${className} AND name = ${name}
    `;
  }

  has(className: string, name: string): boolean {
    this.ensure();
    const rows = this.#host.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM cf_agents_sub_agents
      WHERE class = ${className} AND name = ${name}
    `;
    return (rows[0]?.n ?? 0) > 0;
  }

  list(
    className?: string
  ): Array<{ className: string; name: string; createdAt: number }> {
    this.ensure();
    const rows = className
      ? this.#host.sql<{ class: string; name: string; created_at: number }>`
          SELECT class, name, created_at FROM cf_agents_sub_agents
          WHERE class = ${className}
          ORDER BY created_at ASC
        `
      : this.#host.sql<{ class: string; name: string; created_at: number }>`
          SELECT class, name, created_at FROM cf_agents_sub_agents
          ORDER BY created_at ASC
        `;
    return rows.map((r) => ({
      className: r.class,
      name: r.name,
      createdAt: r.created_at
    }));
  }
}
