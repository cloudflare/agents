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

/**
 * Derives the next per-route sequence number from a `MAX(seq)` read
 * instead of a maintained counter row. Breaks ties between equal
 * `Date.now()` values deterministically by write order, which a random
 * entry `id` cannot: DO SQLite millisecond timestamps collide easily
 * under rapid same-route writes.
 *
 * This scans every row for the route on each create()/setMetadata() —
 * intentionally, not a missed index. DO SQLite bills roughly 1000
 * writes for the cost of 1000 reads, so a maintained counter row (an
 * extra write on every call) only wins at deep four-figure entries per
 * route; a `(route, seq)` index would cost an extra write on every call
 * too, since `seq` changes on every write it would index. `RoutedAgents`
 * targets one owner's own catalog (chats, documents, sessions) — for a
 * route expected to hold thousands of entries, benchmark before relying
 * on this ordering; it is not built for that scale.
 */
const NEXT_SEQ = `(SELECT COALESCE(MAX(seq), 0) + 1 FROM ${TABLE} WHERE route = ?)`;

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
 * Agent needs no matching capability. Destroying the owner condemns every
 * remaining entry with a few retries so targets don't casually outlive
 * their catalog — this is best-effort, not a durability guarantee; see
 * {@link RoutedAgents.dispose}.
 *
 * Pick a `route` that cannot appear as a literal path segment elsewhere
 * under the owner (its own name, another route, or a path the owner's own
 * `onRequest` handles) — forwarding matches every occurrence of the route
 * segment in the path, so a coincidental match with no active entry
 * behind it is answered `404` instead of reaching the owner.
 *
 * A forwarded suffix is not searched for a `/sub/{class}/{name}` dynamic
 * agents marker: `Agent.fetch()` resolves that marker against the OWNER's
 * exported classes before this capability's `onRequest` ever runs, so a
 * matching marker is served as a facet of the owner, not forwarded to the
 * target. Address a target's own dynamic agents through a direct
 * connection to that target, not through the owner's route.
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
   * @param options - Target binding and the route segment this capability
   * claims. Install with `this.lifecycle.use()` before startup.
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
    const encoded = encodeMetadata(options?.metadata ?? null);
    const now = Date.now();
    this.#sql(
      `INSERT INTO ${TABLE} (route, id, agent_name, status, metadata, created_at, updated_at, seq)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ${NEXT_SEQ})`,
      this.#route,
      id,
      crypto.randomUUID(),
      encoded,
      now,
      now,
      this.#route
    );
    // Round-trip through JSON so this agrees with list()'s decoded copy —
    // returning the caller's object verbatim would diverge for values JSON
    // can't represent exactly (undefined fields, NaN, non-plain objects).
    return {
      id,
      metadata: JSON.parse(encoded) as Metadata | null,
      createdAt: now,
      updatedAt: now
    };
  }

  /** Resolve an active entry to an initialized, typed Agent stub. */
  async get(id: string): Promise<DurableObjectStub<TAgent> | null> {
    await this.lifecycle.ready();
    const agentName = this.#agentName(id, "active");
    return agentName ? this.#stub(agentName) : null;
  }

  /**
   * List active entries, most recently updated first. Entries whose
   * `updatedAt` ties are ordered by actual write order, not by the
   * random entry `id`.
   */
  async list(): Promise<ReadonlyArray<RoutedAgentEntry<Metadata>>> {
    await this.lifecycle.ready();
    return this.#sql<EntryRow>(
      `SELECT id, metadata, created_at AS createdAt, updated_at AS updatedAt
       FROM ${TABLE} WHERE route = ? AND status = 'active'
       ORDER BY updated_at DESC, seq DESC, id ASC`,
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
        `UPDATE ${TABLE} SET metadata = ?, updated_at = ?, seq = ${NEXT_SEQ}
         WHERE route = ? AND id = ? AND status = 'active' RETURNING id`,
        encodeMetadata(metadata),
        Date.now(),
        this.#route,
        this.#route,
        id
      ).length > 0
    );
  }

  /**
   * Make an entry unreachable, condemn its Agent, then remove the row.
   * Returns false for unknown IDs.
   *
   * The target is condemned through Agent's deferred teardown, which
   * durably marks it and returns without aborting the isolate; its storage
   * is wiped on its own next wake, moments later, and the marker survives
   * interruption. A failed RPC leaves a hidden `deleting` row so a
   * repeated call retries.
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
    await this.#namespace
      .get(this.#namespace.idFromName(agentName))
      ._cf_scheduleDestroy();
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
      seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (route, id)
    ) WITHOUT ROWID`);
  }

  /**
   * Condemn every remaining entry (including one already `deleting`, in
   * case its own condemnation RPC never landed) when the owner itself is
   * destroyed.
   *
   * `Agent.destroy()` disposes capabilities before it wipes its own
   * storage, so the catalog is still readable here — without this, the
   * catalog would vanish with the owner while every target it named kept
   * running and billing storage, unreachable forever.
   *
   * This is best-effort, not a durability guarantee: `Agent.destroy()`
   * wipes the owner's storage immediately after disposal regardless of
   * whether any capability's `dispose()` reports failure, so a target
   * that is still unreachable after retries here is orphaned for good —
   * there is no later "repeated call retries" for a catalog row that no
   * longer exists. Retrying briefly here converts the common transient
   * failure into a condemned target instead of an orphan; it cannot
   * convert a target that is durably unreachable.
   */
  async dispose(): Promise<void> {
    const entries = this.#sql<{ agentName: string }>(
      `SELECT agent_name AS agentName FROM ${TABLE}
       WHERE route = ? AND status IN ('active', 'deleting')`,
      this.#route
    );
    await Promise.all(
      entries.map(({ agentName }) => this.#condemnWithRetry(agentName))
    );
  }

  async #condemnWithRetry(agentName: string, attempts = 3): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.#namespace
          .get(this.#namespace.idFromName(agentName))
          ._cf_scheduleDestroy();
        return;
      } catch (error) {
        if (attempt === attempts) {
          console.error(
            `RoutedAgents "${this.#route}" could not condemn ${agentName} on owner disposal after ${attempts} attempts; its storage will leak, since the owner's catalog — the only record of it — is wiped immediately after disposal`,
            error
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 50));
      }
    }
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
