import { DurableObject } from "cloudflare:workers";
import { DynamicAgents } from "../../dynamic-agents";
import {
  Lifecycle,
  type DurableObjectCapability,
  type LifecycleRouteEnvelope
} from "../../lifecycle";
import { Scheduler, type Schedule } from "../../schedules";
import { WebSockets } from "../../websockets";
import type { AgentPathStep } from "../../sub-routing";

/** What a child reports about itself. */
export type ChildIdentity = {
  readonly isChild: boolean;
  readonly name: string;
  readonly parentPath: ReadonlyArray<AgentPathStep>;
  /** The identity the host's own `onStart` observed. */
  readonly startedAs: {
    readonly isChild: boolean;
    readonly name: string;
    readonly parentPath: ReadonlyArray<AgentPathStep>;
  } | null;
};

type GateCall = {
  readonly url: string;
  readonly child: { readonly className: string; readonly name: string };
};

const LEGACY_OUTER_URL_KEY = "_cf_subAgentOuterUrl";

/**
 * A plain Durable Object that spawns children with the DynamicAgents
 * capability and owns their sockets. Probes expose the capability's state
 * to tests over RPC.
 */
export class DynamicParentObject extends DurableObject<Cloudflare.Env> {
  readonly gateCalls: GateCall[] = [];
  readonly deniedChildren = new Set<string>();

  readonly children = new DynamicAgents({
    onBeforeChild: (request, child) => {
      this.gateCalls.push({ url: request.url, child });
      if (this.deniedChildren.has(child.name)) {
        return new Response("child denied", {
          status: 403,
          headers: { "x-denied-by": "parent" }
        });
      }
      const url = new URL(request.url);
      if (url.searchParams.has("stamp")) {
        const headers = new Headers(request.headers);
        headers.set("x-stamped-by", "parent");
        return new Request(request, { headers });
      }
      return undefined;
    },
    keepAliveIntervalMs: 5_000
  });

  readonly webSockets = new WebSockets({
    handlers: {
      onConnect: (connection) => {
        connection.send(`parent:${this.lifecycle.name}`);
      },
      onMessage: (connection, message) => {
        connection.send(`parent-echo:${String(message)}`);
      }
    }
  });

  /**
   * Accepts sockets the way the previous release did for a child — under
   * the WebSockets `__pk` namespace with the outer URL in `__user` — so
   * tests can prove those sockets still reach the child.
   */
  readonly #legacySockets: DurableObjectCapability = {
    onWebSocketUpgrade: ({ request }) => {
      const url = new URL(request.url);
      if (!url.pathname.includes("/legacy/")) return undefined;
      const outer = url.searchParams.get("outer");
      if (!outer) return undefined;
      const { 0: client, 1: server } = new WebSocketPair();
      const id = url.searchParams.get("_pk") || crypto.randomUUID();
      this.ctx.acceptWebSocket(server, [id]);
      server.serializeAttachment({
        __pk: { id, tags: [id], uri: request.url },
        __user: { [LEGACY_OUTER_URL_KEY]: outer }
      });
      return new Response(null, { status: 101, webSocket: client });
    }
  };

  /** Stores the children's routed schedules; the root owns the alarm. */
  readonly scheduler = new Scheduler();

  readonly lifecycle = Lifecycle.install(this)
    .use(this.children)
    .use(this.scheduler)
    .use(this.#legacySockets)
    .use(this.webSockets, { fallback: true });

  _cf_lifecycle(envelope: LifecycleRouteEnvelope): Promise<unknown> {
    return this.lifecycle.route(envelope);
  }

  onRequest(request: Request): Response {
    const url = new URL(request.url);
    return new Response(`parent:${this.lifecycle.name}:${url.pathname}`);
  }

  // ── Probes ───────────────────────────────────────────────────────────

  async spawn(name: string): Promise<ChildIdentity> {
    const child = await this.children.get(DynamicChildObject, name);
    return child.identity();
  }

  async increment(name: string): Promise<number> {
    const child = await this.children.get(DynamicChildObject, name);
    return child.increment();
  }

  async spawnGrandchild(
    name: string,
    grandchild: string
  ): Promise<ChildIdentity> {
    const child = await this.children.get(DynamicChildObject, name);
    return child.spawnGrandchild(grandchild);
  }

  has(name: string): boolean {
    return this.children.has(DynamicChildObject, name);
  }

  list(): string[] {
    return this.children.list(DynamicChildObject).map((entry) => entry.name);
  }

  abort(name: string): void {
    this.children.abort(DynamicChildObject, name, new Error("aborted by test"));
  }

  delete(name: string): Promise<void> {
    return this.children.delete(DynamicChildObject, name);
  }

  denyChild(name: string): void {
    this.deniedChildren.add(name);
  }

  getGateCalls(): GateCall[] {
    return this.gateCalls;
  }

  /**
   * Ids of the parent's own connections. Sockets a previous release
   * accepted for a child through WebSockets are still enumerated there;
   * a host skips them the way Agent does.
   */
  connectionIds(): string[] {
    return [...this.webSockets.getConnections()]
      .filter((c) => !this.children.ownsConnection(c))
      .map((c) => c.id);
  }

  /** Ids of every hibernated socket on this object, whoever owns it. */
  async socketIds(): Promise<string[]> {
    await this.lifecycle.start();
    return this.ctx.getWebSockets().map((ws) => {
      const attachment = ws.deserializeAttachment() as {
        __cf_da?: { id?: string };
        __pk?: { id?: string };
      } | null;
      return attachment?.__cf_da?.id ?? attachment?.__pk?.id ?? "?";
    });
  }

  keepAliveHolds(): number {
    return this.children.keepAliveHolds;
  }

  async leaseRows(): Promise<Array<{ owner: string; id: string }>> {
    await this.lifecycle.start();
    return [
      ...this.ctx.storage.sql.exec<{ owner_path_key: string; run_id: string }>(
        "SELECT owner_path_key, run_id FROM cf_agents_facet_runs ORDER BY created_at"
      )
    ].map((row) => ({ owner: row.owner_path_key, id: row.run_id }));
  }

  /** Every queued Lifecycle job, by owner and fn. */
  async jobs(): Promise<Array<{ owner: string; fn: string }>> {
    await this.lifecycle.start();
    return [
      ...this.ctx.storage.sql.exec<{ owner: string; fn: string }>(
        "SELECT capability AS owner, fn FROM cf_agents_jobs ORDER BY time"
      )
    ];
  }

  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  async sweepLeases(): Promise<void> {
    await this.lifecycle.start();
    await this.children.sweepLeases();
  }

  async childLeaseChecks(name: string): Promise<number> {
    const child = await this.children.get(DynamicChildObject, name);
    return child.leaseChecks();
  }

  async childHoldLease(name: string, id: string): Promise<void> {
    const child = await this.children.get(DynamicChildObject, name);
    await child.holdLease(id);
  }

  async childReleaseLease(name: string, id: string): Promise<void> {
    const child = await this.children.get(DynamicChildObject, name);
    await child.releaseLease(id);
  }

  async childKeepAlive(
    name: string,
    action: "hold" | "release"
  ): Promise<void> {
    const child = await this.children.get(DynamicChildObject, name);
    if (action === "hold") await child.holdKeepAlive();
    else await child.releaseKeepAlives();
  }

  async childSchedule(name: string, delaySeconds: number): Promise<string> {
    const child = await this.children.get(DynamicChildObject, name);
    return child.scheduleTick(delaySeconds);
  }

  async childSchedules(name: string): Promise<number> {
    const child = await this.children.get(DynamicChildObject, name);
    return child.scheduleCount();
  }

  async childTicks(name: string): Promise<number> {
    const child = await this.children.get(DynamicChildObject, name);
    return child.ticks();
  }

  async childConnectionIds(name: string, tag?: string): Promise<string[]> {
    const child = await this.children.get(DynamicChildObject, name);
    return child.connectionIds(tag);
  }

  async childBroadcast(name: string, message: string): Promise<void> {
    const child = await this.children.get(DynamicChildObject, name);
    await child.broadcastToOwn(message);
  }

  async childDeleteSelf(name: string): Promise<void> {
    const child = await this.children.get(DynamicChildObject, name);
    try {
      await child.deleteSelf();
    } catch {
      // Deleting the child aborts its isolate mid-call.
    }
  }

  async childRehydrate(name: string): Promise<string[]> {
    const child = await this.children.get(DynamicChildObject, name);
    return child.rehydrateConnections();
  }
}

/** A plain child: its own storage, scheduler, and WebSocket handlers. */
export class DynamicChildObject extends DurableObject<Cloudflare.Env> {
  #startedAs: ChildIdentity["startedAs"] = null;
  #heldLeases = new Set<string>();
  #leaseChecks = 0;
  #keepAliveReleases: Array<() => void> = [];
  #ticks = 0;

  readonly children = new DynamicAgents({
    checkLeases: () => {
      this.#leaseChecks += 1;
      return this.#heldLeases.size;
    }
  });

  readonly scheduler = new Scheduler({
    callbacks: {
      tick: () => {
        this.#ticks += 1;
      }
    }
  });

  readonly webSockets = new WebSockets({
    handlers: {
      onConnect: (connection, ctx) => {
        const url = new URL(ctx.request.url);
        connection.setState({ greeted: true });
        connection.send(
          `child:${this.children.name}:${url.pathname}:${ctx.request.headers.get("x-stamped-by") ?? "-"}`
        );
      },
      onMessage: (connection, message) => {
        const text = String(message);
        if (text.startsWith("echo:")) {
          connection.send(`echo:${text.slice(5)}:${this.children.name}`);
        } else if (text.startsWith("broadcast:")) {
          for (const peer of this.webSockets.getConnections()) {
            peer.send(`broadcast:${text.slice(10)}`);
          }
        } else if (text.startsWith("state:")) {
          connection.setState(JSON.parse(text.slice(6)));
          connection.send(`state:${JSON.stringify(connection.state)}`);
        } else if (text === "state?") {
          connection.send(`state:${JSON.stringify(connection.state)}`);
        } else if (text === "who") {
          connection.send(
            `who:${connection.id}:${[...connection.tags].join(",")}`
          );
        } else if (text === "close") {
          connection.close(4000, "closed by child");
        } else if (text === "peers") {
          connection.send(
            `peers:${[...this.webSockets.getConnections()].map((c) => c.id).join(",")}`
          );
        }
      },
      onClose: (connection, code) => {
        this.ctx.storage.put(`closed:${connection.id}`, code);
      }
    },
    getConnectionTags: () => ["child-tag"]
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.children)
    .use(this.scheduler)
    .use(this.webSockets, { fallback: true });

  _cf_lifecycle(envelope: LifecycleRouteEnvelope): Promise<unknown> {
    return this.lifecycle.route(envelope);
  }

  onStart(): void {
    this.#startedAs = {
      isChild: this.children.isChild,
      name: this.children.name,
      parentPath: this.children.parentPath
    };
  }

  onRequest(request: Request): Response {
    const url = new URL(request.url);
    return new Response(
      `child:${this.children.name}:${url.pathname}:${request.headers.get("x-stamped-by") ?? "-"}`
    );
  }

  identity(): ChildIdentity {
    return {
      isChild: this.children.isChild,
      name: this.children.name,
      parentPath: this.children.parentPath,
      startedAs: this.#startedAs
    };
  }

  increment(): number {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY, n INTEGER)"
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO hits (id, n) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1"
    );
    return this.ctx.storage.sql
      .exec<{ n: number }>("SELECT n FROM hits WHERE id = 1")
      .one().n;
  }

  async spawnGrandchild(name: string): Promise<ChildIdentity> {
    const grandchild = await this.children.get(DynamicGrandchildObject, name);
    return grandchild.identity();
  }

  connectionIds(tag?: string): string[] {
    return [...this.webSockets.getConnections(tag)].map((c) => c.id);
  }

  async broadcastToOwn(message: string): Promise<void> {
    await this.children.broadcast(message);
  }

  async rehydrateConnections(): Promise<string[]> {
    await this.children.clearVirtualConnections();
    await this.children.hydrateConnectionsFromRoot();
    return this.connectionIds();
  }

  async holdLease(id: string): Promise<void> {
    this.#heldLeases.add(id);
    await this.children.holdLease(id);
  }

  async releaseLease(id: string): Promise<void> {
    this.#heldLeases.delete(id);
    await this.children.releaseLease(id);
  }

  leaseChecks(): number {
    return this.#leaseChecks;
  }

  async holdKeepAlive(): Promise<void> {
    this.#keepAliveReleases.push(await this.children.keepAlive());
  }

  async releaseKeepAlives(): Promise<void> {
    for (const release of this.#keepAliveReleases.splice(0)) release();
    // Releases are fire-and-forget; give them a turn to reach the root.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  async scheduleTick(delaySeconds: number): Promise<string> {
    const schedule = await this.scheduler.set(delaySeconds, "tick");
    return schedule.id;
  }

  async scheduleCount(): Promise<number> {
    const schedules: Schedule<unknown>[] = await this.scheduler.list();
    return schedules.length;
  }

  ticks(): number {
    return this.#ticks;
  }

  deleteSelf(): Promise<void> {
    return this.children.deleteSelf();
  }
}

/** A grandchild: the nesting case, with no WebSockets of its own. */
export class DynamicGrandchildObject extends DurableObject<Cloudflare.Env> {
  #startedAs: ChildIdentity["startedAs"] = null;
  readonly children = new DynamicAgents();
  readonly lifecycle = Lifecycle.install(this).use(this.children);

  _cf_lifecycle(envelope: LifecycleRouteEnvelope): Promise<unknown> {
    return this.lifecycle.route(envelope);
  }

  onStart(): void {
    this.#startedAs = {
      isChild: this.children.isChild,
      name: this.children.name,
      parentPath: this.children.parentPath
    };
  }

  onRequest(request: Request): Response {
    return new Response(
      `grandchild:${this.children.name}:${new URL(request.url).pathname}`
    );
  }

  identity(): ChildIdentity {
    return {
      isChild: this.children.isChild,
      name: this.children.name,
      parentPath: this.children.parentPath,
      startedAs: this.#startedAs
    };
  }
}
