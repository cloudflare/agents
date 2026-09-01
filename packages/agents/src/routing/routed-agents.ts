import { getAgentByName } from "../agent-routing";
import type { Agent } from "../index";
import { LifecycleCapability } from "../lifecycle/capability";
import type {
  CapabilityRequestContext,
  CapabilityWebSocketUpgradeContext
} from "../lifecycle/capability-runner";

/**
 * Catalog of the entries an owning Durable Object has created, keyed by
 * route so several namespaces can share one owner. `WITHOUT ROWID` keeps
 * an insert at one billed row; `agent_name` is a random UUID, so it needs
 * no unique index of its own.
 */
const TABLE = "cf_agents_routed_agents";

/** A public entry in an {@link RoutedAgents}. */
export type RoutedAgentEntry<Metadata = unknown> = {
  /** Stable application-facing identifier used in routes. */
  readonly id: string;
  /** Application-owned metadata stored with the entry. */
  readonly metadata: Metadata | null;
  /** Creation time, as Unix milliseconds. */
  readonly createdAt: number;
  /** Time the entry or its metadata last changed, as Unix milliseconds. */
  readonly updatedAt: number;
};

/** Options for creating an entry in an {@link RoutedAgents}. */
export type RoutedAgentCreateOptions<Metadata = unknown> = {
  /** Initial application-owned metadata. */
  readonly metadata?: Metadata;
};

/** Configuration for an {@link RoutedAgents}. */
export type RoutedAgentsOptions<TAgent extends Agent> = {
  /** Top-level Durable Object namespace the entries are created in. */
  readonly namespace: DurableObjectNamespace<TAgent>;
  /** One URL-safe path segment under the owning Durable Object. */
  readonly route: string;
};

type EntryRow = {
  id: string;
  metadata: string;
  createdAt: number;
  updatedAt: number;
};

function encodeMetadata(value: unknown): string {
  const encoded = JSON.stringify(value ?? null);
  if (encoded === undefined) {
    throw new TypeError("RoutedAgents metadata must be JSON-serializable");
  }
  return encoded;
}

/**
 * A durable, routed collection of independent top-level Agents.
 *
 * Install this on the owning Durable Object, typically a per-user hub. It
 * maps public entry IDs to opaque physical Agent names, handles catalog
 * CRUD without waking any target, and forwards matching HTTP requests and
 * WebSocket upgrades to the selected Agent. After an upgrade the target
 * owns the socket, so ordinary frames never wake the owner. The target
 * Agent needs no matching capability.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class RoutedAgents<
  TAgent extends Agent = Agent,
  Metadata = unknown
> extends LifecycleCapability {
  readonly #namespace: DurableObjectNamespace<TAgent>;
  readonly #route: string;

  /**
   * @param options - Target binding and the route segment this namespace
   * claims. Install with the protected `Agent.use()` helper, or with
   * `Lifecycle.use()` on a plain Durable Object.
   */
  constructor(options: RoutedAgentsOptions<TAgent>) {
    const route = options.route.replace(/^\/+|\/+$/g, "");
    if (!/^[A-Za-z0-9_-]+$/.test(route)) {
      throw new Error(
        "RoutedAgents route must be one non-empty URL-safe path segment"
      );
    }
    super(`routed-agents:${route}`);
    this.#namespace = options.namespace;
    this.#route = route;
  }

  /** Create an entry without waking the target Agent. */
  async create(
    options?: RoutedAgentCreateOptions<Metadata>
  ): Promise<RoutedAgentEntry<Metadata>> {
    await this.lifecycle.ready();
    const id = crypto.randomUUID();
    const metadata = options?.metadata ?? null;
    const now = Date.now();
    this.#sql(
      `INSERT INTO ${TABLE} (route, id, agent_name, status, metadata, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      this.#route,
      id,
      crypto.randomUUID(),
      encodeMetadata(metadata),
      now,
      now
    );
    return { id, metadata, createdAt: now, updatedAt: now };
  }

  /** Resolve an active entry to an initialized, typed Agent stub. */
  async get(id: string): Promise<DurableObjectStub<TAgent> | null> {
    await this.lifecycle.ready();
    const agentName = this.#agentName(id, "active");
    return agentName ? this.#stub(agentName) : null;
  }

  /** List active entries, most recently updated first. */
  async list(): Promise<ReadonlyArray<RoutedAgentEntry<Metadata>>> {
    await this.lifecycle.ready();
    return this.#sql<EntryRow>(
      `SELECT id, metadata, created_at AS createdAt, updated_at AS updatedAt
       FROM ${TABLE} WHERE route = ? AND status = 'active'
       ORDER BY updated_at DESC, id ASC`,
      this.#route
    ).map((row) => ({
      ...row,
      // SAFETY: written by create() or setMetadata() from a Metadata value.
      // Changing Metadata for an existing namespace needs an application
      // migration; JSON carries no type to recover.
      metadata: JSON.parse(row.metadata) as Metadata | null
    }));
  }

  /** Replace an active entry's metadata. Returns false for unknown IDs. */
  async setMetadata(id: string, metadata: Metadata | null): Promise<boolean> {
    await this.lifecycle.ready();
    return (
      this.#sql(
        `UPDATE ${TABLE} SET metadata = ?, updated_at = ?
         WHERE route = ? AND id = ? AND status = 'active' RETURNING id`,
        encodeMetadata(metadata),
        Date.now(),
        this.#route,
        id
      ).length > 0
    );
  }

  /**
   * Make an entry unreachable, destroy its Agent, then remove the row.
   * A failed destroy leaves a hidden `deleting` row so a repeated call
   * retries. Returns false for unknown IDs.
   */
  async delete(id: string): Promise<boolean> {
    await this.lifecycle.ready();
    const agentName = this.#agentName(id);
    if (!agentName) return false;
    this.#sql(
      `UPDATE ${TABLE} SET status = 'deleting', updated_at = ?
       WHERE route = ? AND id = ?`,
      Date.now(),
      this.#route,
      id
    );
    await (await this.#stub(agentName)).destroy();
    this.#sql(
      `DELETE FROM ${TABLE} WHERE route = ? AND id = ?`,
      this.#route,
      id
    );
    return true;
  }

  override onStart(): void {
    this.#sql(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      route TEXT NOT NULL,
      id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'deleting')),
      metadata TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (route, id)
    ) WITHOUT ROWID`);
  }

  /** Forward a matching HTTP request to the selected Agent. */
  onRequest({
    request
  }: CapabilityRequestContext): Promise<Response | undefined> {
    return this.#forward(request);
  }

  /** Forward a matching upgrade so the selected Agent owns the WebSocket. */
  onWebSocketUpgrade({
    request
  }: CapabilityWebSocketUpgradeContext): Promise<Response | undefined> {
    return this.#forward(request);
  }

  /**
   * The route segment may also appear as the owner's own name or inside
   * the forwarded suffix, so every `/{route}/{id}` occurrence is tried
   * against the catalog and the first active entry wins. A route match
   * with no active entry is a 404; no match at all lets the request
   * continue to the owner's other capabilities.
   */
  async #forward(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/");
    let matched = false;
    for (let i = 1; i < segments.length - 1; i++) {
      if (segments[i] !== this.#route || segments[i + 1] === "") continue;
      matched = true;
      const agentName = this.#agentName(decode(segments[i + 1]), "active");
      if (!agentName) continue;
      url.pathname = `/${segments.slice(i + 2).join("/")}`;
      return this.#namespace
        .get(this.#namespace.idFromName(agentName))
        .fetch(new Request(url, request));
    }
    return matched
      ? new Response("Agent not found", { status: 404 })
      : undefined;
  }

  /** Initialized stub; the explicit generics keep inference shallow. */
  #stub(agentName: string): Promise<DurableObjectStub<TAgent>> {
    return getAgentByName<Cloudflare.Env, TAgent>(this.#namespace, agentName);
  }

  #agentName(id: string, status?: "active"): string | undefined {
    const [row] = this.#sql<{ agentName: string }>(
      `SELECT agent_name AS agentName FROM ${TABLE}
       WHERE route = ? AND id = ? AND status = COALESCE(?, status)`,
      this.#route,
      id,
      status ?? null
    );
    return row?.agentName;
  }

  #sql<Row extends Record<string, SqlStorageValue>>(
    query: string,
    ...values: SqlStorageValue[]
  ): Row[] {
    return this.lifecycle.storage.sql.exec<Row>(query, ...values).toArray();
  }
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
