import type { DurableObject } from "cloudflare:workers";
import { nanoid } from "nanoid";
import {
  LifecycleCapability,
  type CapabilityRequestContext,
  type CapabilityWebSocketUpgradeContext,
  type Connection,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
  type LifecycleRouteAddress,
  type LifecycleRouteContext,
  type LifecycleRouteEnvelope,
  type LifecycleRouteInbound,
  type LifecycleRouteRetirement,
  type LifecycleRouteTransport,
  type WSMessage
} from "../lifecycle";
import {
  getCurrentAgent,
  runWithoutCurrentAgent
} from "../lifecycle/current-agent";
import {
  SUB_PREFIX,
  parseSubAgentPath,
  type AgentPathStep,
  type SubAgentPathMatch
} from "../sub-routing";
import { camelCaseToKebabCase, isInternalJsStubProp } from "../utils";
import type {
  BridgedConnectionMeta,
  WebSocketsRouteMessage
} from "../websockets/bridged";
import { reciprocateClose } from "../websockets/close";
import {
  DynamicAgentConnectionBridge,
  dynamicAgentRpcReplyContext,
  type DynamicAgentConnectionOps,
  type DynamicAgentRpcReplyInvocationContext
} from "./bridges";
import { ChildConnectionRouter } from "./child-connections";
import {
  agentPathKey,
  isSameAgentPath,
  isSameAgentPathPrefix,
  isValidParentPath,
  logicalNameFromPathV2Identity,
  ownerKeyUnder,
  routeAddressForPath
} from "./identity";
import {
  DYNAMIC_AGENTS_CAPABILITY_ID,
  isDynamicAgentRouteMessage,
  type DynamicAgentRouteMessage
} from "./protocol";
import {
  DynamicAgentRegistry,
  registrySqlHost,
  type DynamicAgentRegistrySqlHost
} from "./registry";
import {
  acceptOwnedSocket,
  ownedSocket,
  ownedSocketById,
  ownedSockets,
  SUB_AGENT_OUTER_URL_HEADER,
  type RootSocketRecord
} from "./sockets";
import type {
  DynamicAgentClass,
  DynamicAgentConnectionBridgeLike,
  DynamicAgentConnectionMeta,
  DynamicAgentRef,
  DynamicAgentsOptions,
  DynamicAgentStub,
  FacetRunStorageRow
} from "./types";

const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 30_000;
const KEEP_ALIVE_JOB_ID = "keep-alive";
const LEASE_SWEEP_JOB_ID = "lease-sweep";

/** Storage-frozen keys a child's identity is persisted under. */
const IS_CHILD_STORAGE_KEY = "cf_agents_is_facet";
const CHILD_NAME_STORAGE_KEY = "cf_agents_facet_name";
const PARENT_PATH_STORAGE_KEY = "cf_agents_parent_path";

/** What every child stub exposes to its parent. */
type ChildStub = {
  _cf_lifecycle(envelope: LifecycleRouteEnvelope): Promise<unknown>;
  fetch(request: Request): Promise<Response>;
} & Record<string, (...args: unknown[]) => Promise<unknown>>;

type Identity = {
  readonly isChild: boolean;
  readonly childName?: string;
  readonly parentPath: ReadonlyArray<AgentPathStep>;
};

type ForwardedFrame =
  | { readonly type: "ws:connect" }
  | {
      readonly type: "ws:message";
      readonly message: WSMessage;
      readonly replyBridge?: DynamicAgentConnectionBridge;
    }
  | {
      readonly type: "ws:close";
      readonly code: number;
      readonly reason: string;
      readonly wasClean: boolean;
    };

function bridgedMeta(meta: DynamicAgentConnectionMeta): BridgedConnectionMeta {
  return { id: meta.id, uri: meta.uri, tags: meta.tags, state: meta.state };
}

/**
 * Dynamic agents: child Durable Objects that run in their own isolate with
 * their own SQLite database, colocated with — and supervised by — the
 * object that spawned them (workerd facets).
 *
 * Install it on any Lifecycle Object, before capabilities that route to
 * children (Scheduler, Tasks) and before WebSockets:
 *
 * ```ts
 * class Workspace extends DurableObject<Env> {
 *   readonly children = new DynamicAgents();
 *   readonly lifecycle = Lifecycle.install(this).use(this.children);
 *
 *   _cf_lifecycle(envelope: LifecycleRouteEnvelope) {
 *     return this.lifecycle.route(envelope);
 *   }
 *
 *   async open(name: string) {
 *     const notebook = await this.children.get(Notebook, name);
 *     await notebook.hello();
 *   }
 * }
 * ```
 *
 * The one-line `_cf_lifecycle` method is the native-RPC aperture routed
 * capabilities travel through; a child needs the same line. HTTP requests
 * and WebSocket upgrades to `/sub/{child-class}/{name}/...` are forwarded
 * to the child; its sockets stay on the parent and are bridged into the
 * child's WebSockets capability. Use dynamic agents for code whose class
 * or lifecycle the parent owns; for independent peers, address a
 * top-level Durable Object by name instead.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class DynamicAgents extends LifecycleCapability {
  readonly #options: DynamicAgentsOptions;
  #inbound: LifecycleRouteInbound | undefined;
  #identity: Identity = { isChild: false, parentPath: [] };
  #registryInstance: DynamicAgentRegistry | undefined;
  #connectionsInstance: ChildConnectionRouter | undefined;
  /** Root-held keep-alive tokens, by token → owner key. */
  readonly #keepAliveTokens = new Map<string, string>();
  #sweep: Promise<void> | undefined;

  constructor(options: DynamicAgentsOptions = {}) {
    super(DYNAMIC_AGENTS_CAPABILITY_ID);
    this.#options = options;
  }

  // ── Identity ─────────────────────────────────────────────────────────

  /** Whether this object is a dynamic agent spawned by a parent. */
  get isChild(): boolean {
    return this.#identity.isChild;
  }

  /** The logical name: the name the parent gave a child, or the routed name. */
  get name(): string {
    const routed = this.lifecycle.object.name();
    return (
      this.#identity.childName ??
      logicalNameFromPathV2Identity(routed) ??
      routed
    );
  }

  /** Ancestor chain, root-first. Empty for a top-level object. */
  get parentPath(): ReadonlyArray<AgentPathStep> {
    return this.#identity.parentPath;
  }

  /** Ancestor chain plus this object, root-first. */
  get selfPath(): ReadonlyArray<AgentPathStep> {
    return [
      ...this.#identity.parentPath,
      { className: this.lifecycle.object.className, name: this.name }
    ];
  }

  // ── Children ─────────────────────────────────────────────────────────

  /**
   * Get (creating or waking if needed) the child of the given class and
   * name, as a typed RPC stub. Idempotent.
   */
  async get<T extends DurableObject>(
    cls: DynamicAgentClass<T>,
    name: string
  ): Promise<DynamicAgentStub<T>> {
    return (await this.resolve(cls.name, name)) as DynamicAgentStub<T>;
  }

  /**
   * Forcefully abort a running child. It stops immediately and restarts on
   * the next {@link get}; its storage is preserved. Transitively aborts
   * the child's own children. Pending RPC calls receive `reason`.
   */
  abort(cls: DynamicAgentClass | string, name: string, reason?: unknown): void {
    const className = typeof cls === "string" ? cls : cls.name;
    this.lifecycle.facets.abort(facetKey(className, name), reason);
  }

  /**
   * Delete a child: abort it if running, then permanently wipe its
   * storage and every root-owned mirror for it and its descendants.
   */
  async delete(cls: DynamicAgentClass | string, name: string): Promise<void> {
    const className = typeof cls === "string" ? cls : cls.name;
    await this.lifecycle.ready();
    await this.#retire([...this.selfPath, { className, name }]);
    try {
      this.lifecycle.facets.delete(facetKey(className, name));
    } catch {
      // Idempotent: the child was already deleted or never spawned.
    }
    this.#registry.forget(className, name);
  }

  /** Whether this object has spawned (and not deleted) the given child. */
  has(cls: DynamicAgentClass | string, name: string): boolean {
    const className = typeof cls === "string" ? cls : cls.name;
    return this.#registry.has(className, name);
  }

  /** Known children, optionally filtered by class. */
  list(
    cls?: DynamicAgentClass | string
  ): Array<{ className: string; name: string; createdAt: number }> {
    const className = typeof cls === "string" ? cls : cls?.name;
    return this.#registry.list(className);
  }

  // ── Self ─────────────────────────────────────────────────────────────

  /**
   * A typed stub for this child's immediate parent. Calls travel through
   * the root, so they reach a parent that is itself a child.
   */
  parent<T extends DurableObject>(
    cls: DynamicAgentClass<T>
  ): DynamicAgentStub<T> {
    const parent = this.#identity.parentPath.at(-1);
    if (!parent) {
      throw new Error(
        "parent() is only available inside a dynamic agent spawned by a parent."
      );
    }
    if (parent.className !== cls.name) {
      throw new Error(
        `parent(${cls.name}) does not match this child's parent class "${parent.className}".`
      );
    }
    const path = this.#identity.parentPath;
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (isInternalJsStubProp(prop) || typeof prop !== "string") {
            return undefined;
          }
          return (...args: unknown[]) =>
            this.lifecycle.routes.toRoot({
              type: "invoke",
              path,
              method: prop,
              args
            } satisfies DynamicAgentRouteMessage);
        }
      }
    ) as DynamicAgentStub<T>;
  }

  /** Delete this child (from inside it): abort, then wipe its storage. */
  async deleteSelf(): Promise<void> {
    if (!this.isChild) {
      throw new Error("deleteSelf() is only available inside a dynamic agent.");
    }
    await this.lifecycle.routes.toRoot({
      type: "destroy",
      target: this.selfPath
    } satisfies DynamicAgentRouteMessage);
  }

  /**
   * Hold the root's heartbeat so this object is not evicted mid-work.
   * Children have no alarm of their own; the root arms one on their
   * behalf. Returns the release function.
   */
  async keepAlive(): Promise<() => void> {
    await this.lifecycle.ready();
    const owner = this.selfPath;
    const token = this.isChild
      ? ((await this.lifecycle.routes.toRoot({
          type: "keepalive:acquire",
          owner
        } satisfies DynamicAgentRouteMessage)) as string)
      : await this.#acquireKeepAlive(owner);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const release = this.isChild
        ? this.lifecycle.routes.toRoot({
            type: "keepalive:release",
            token
          } satisfies DynamicAgentRouteMessage)
        : this.#releaseKeepAlive(token);
      this.lifecycle.waitUntil(
        Promise.resolve(release).catch((error) => {
          console.error("[Agent] Failed to release facet keepAlive:", error);
        })
      );
    };
  }

  /**
   * Register durable work the root must periodically ask this object to
   * recover (see `checkLeases`) while it holds the lease.
   */
  async holdLease(id: string): Promise<void> {
    await this.lifecycle.ready();
    if (this.isChild) {
      await this.lifecycle.routes.toRoot({
        type: "lease:register",
        owner: this.selfPath,
        id
      } satisfies DynamicAgentRouteMessage);
      return;
    }
    await this.#registerLease(this.selfPath, id);
  }

  /** Release a lease held with {@link holdLease}. */
  async releaseLease(id: string): Promise<void> {
    await this.lifecycle.ready();
    if (this.isChild) {
      await this.lifecycle.routes.toRoot({
        type: "lease:unregister",
        owner: this.selfPath,
        id
      } satisfies DynamicAgentRouteMessage);
      return;
    }
    await this.#unregisterLease(this.selfPath, id);
  }

  /**
   * Ask every leased descendant to recover its work, pruning leases that
   * report nothing left. Runs on the root's heartbeat; a host that drives
   * housekeeping from its own alarm may call it as well.
   */
  sweepLeases(): Promise<void> {
    this.#sweep ??= this.lifecycle
      .ready()
      .then(() => this.#sweepLeases())
      .finally(() => {
        this.#sweep = undefined;
      });
    return this.#sweep;
  }

  /** Send a message to every connection addressed to this object. */
  async broadcast(message: WSMessage, without?: string[]): Promise<void> {
    await this.lifecycle.ready();
    await this.broadcastToPath(this.selfPath, message, without);
  }

  /** Root-held keep-alive tokens currently outstanding. */
  get keepAliveHolds(): number {
    return this.#keepAliveTokens.size;
  }

  // ── Host helpers ─────────────────────────────────────────────────────

  /** Whether a request is addressed to a child rather than this object. */
  requestTargetsChild(request: Request): boolean {
    return (
      parseSubAgentPath(request.url, { knownClasses: this.#knownClasses() }) !==
      null
    );
  }

  /** Whether a connection's URL is addressed to a child rather than this object. */
  connectionTargetsChild(connection: Connection): boolean {
    if (!connection.uri) return false;
    return (
      parseSubAgentPath(connection.uri, {
        knownClasses: this.#knownClasses()
      }) !== null
    );
  }

  /**
   * Whether this capability owns a connection's socket on behalf of a
   * child. Sockets accepted by a previous release through the WebSockets
   * capability are still enumerated there; hosts skip them with this.
   */
  ownsConnection(connection: Connection): boolean {
    return ownedSocket(connection) !== null;
  }

  /** Invoke a method on the object at an absolute, root-first path. */
  async invokeAt(
    path: ReadonlyArray<AgentPathStep>,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const selfPath = this.selfPath;
    if (!isSameAgentPathPrefix(selfPath, path)) {
      throw new Error(
        `Workflow origin path does not descend from ${JSON.stringify(selfPath)}.`
      );
    }
    if (selfPath.length === path.length) {
      return this.#invokeLocal(method, args);
    }
    const next = path[selfPath.length];
    if (!this.#registry.has(next.className, next.name)) {
      throw new Error(
        `Workflow origin sub-agent ${next.className} "${next.name}" no longer exists.`
      );
    }
    const child = await this.resolve(next.className, next.name);
    return child._cf_lifecycle(
      this.#envelope({ type: "invoke", path, method, args })
    );
  }

  /**
   * Invoke a stub method along a path that starts at this object (the
   * shape `parentAgent()` and `_cf_invokeSubAgentPath` use). The last hop
   * is a real RPC on the target's stub, so `fetch(url, init)` and every
   * other stub-shaped call behaves as it does on a top-level stub.
   */
  async invokePath(
    path: ReadonlyArray<AgentPathStep>,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const [self, next, ...rest] = path;
    if (!self) {
      throw new Error("Sub-agent path invocation requires a non-empty path.");
    }
    const ownClassName = this.lifecycle.object.className;
    if (self.className !== ownClassName || self.name !== this.name) {
      throw new Error(
        `Sub-agent path invocation reached ${ownClassName}("${this.name}") ` +
          `but expected ${self.className}("${self.name}").`
      );
    }
    if (!next) return this.#invokeLocal(method, args);
    const child = await this.resolve(next.className, next.name);
    if (rest.length === 0) {
      return invokeStubMethod(child, next.className, method, args);
    }
    return child._cf_lifecycle(
      this.#envelope({
        type: "invoke:path",
        path: [next, ...rest],
        method,
        args
      })
    );
  }

  /** Resolve an immediate child and dispatch one RPC method on it. */
  async invokeChild(
    className: string,
    name: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const stub = await this.resolve(className, name);
    return invokeStubMethod(stub, className, method, args);
  }

  // ── Lifecycle capability hooks ───────────────────────────────────────

  provideRouteTransport(
    inbound: LifecycleRouteInbound
  ): LifecycleRouteTransport {
    this.#inbound = inbound;
    const self = this;
    return {
      get source() {
        return self.#routeAddress();
      },
      toRoot: (envelope) => this.#sendToRoot(envelope),
      to: (target, envelope) => this.routeTo(target, envelope)
    };
  }

  async onStart(): Promise<void> {
    await this.#assertHostAperture();
    this.#ensureLeaseTable();
    if (!this.#identity.isChild) await this.#restoreIdentity();
    if (this.isChild) {
      await this.#hydrate({ deliverEmpty: false });
      return;
    }
    if (this.#leaseRows().length > 0) await this.#ensureLeaseSweep();
  }

  /** Forward `/sub/{class}/{name}/...` HTTP requests to the child. */
  async onRequest({
    request
  }: CapabilityRequestContext): Promise<Response | undefined> {
    const match = parseSubAgentPath(request.url, {
      knownClasses: this.#knownClasses()
    });
    if (!match) return undefined;
    const decision = await this.#gate(request, match);
    if (decision instanceof Response) return decision;
    return this.#forwardRequest(
      decision instanceof Request ? decision : request,
      match
    );
  }

  /** Accept `/sub/...` upgrades on the child's behalf and forward the connect. */
  async onWebSocketUpgrade({
    request
  }: CapabilityWebSocketUpgradeContext): Promise<Response | undefined> {
    const match = this.#matchChild(request.url);
    if (!match) return undefined;
    const decision = await this.#gate(request, match);
    if (decision instanceof Response) return decision;
    const forwardRequest = decision instanceof Request ? decision : request;

    const { 0: client, 1: server } = new WebSocketPair();
    // `||`, not `??`: an empty `?_pk=` value must fall back to a generated id.
    const id = new URL(request.url).searchParams.get("_pk") || nanoid();
    const record = acceptOwnedSocket(this.lifecycle.sockets, server, {
      id,
      outer: request.headers.get(SUB_AGENT_OUTER_URL_HEADER) ?? request.url,
      tags: [id],
      state: null
    });
    const child = await this.resolve(match.childClass, match.childName);
    await child._cf_lifecycle(
      this.#envelope({
        type: "ws:connect",
        meta: this.#metaFor(record, match, forwardRequest),
        bridge: this.#bridgeFor(record)
      })
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async onWebSocketMessage(
    ws: WebSocket,
    message: WSMessage
  ): Promise<boolean> {
    const record = ownedSocket(ws);
    if (!record) return false;
    await this.#forwardFrame(record, {
      type: "ws:message",
      message,
      replyBridge: dynamicAgentRpcReplyContext.getStore()?.bridge
    });
    return true;
  }

  async onWebSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<boolean> {
    const record = ownedSocket(ws);
    if (!record) return false;
    try {
      await this.#forwardFrame(record, {
        type: "ws:close",
        code,
        reason,
        wasClean
      });
    } finally {
      reciprocateClose(ws, code, reason);
    }
    return true;
  }

  async onWebSocketError(ws: WebSocket, error: unknown): Promise<boolean> {
    const record = ownedSocket(ws);
    if (!record) return false;
    console.error(`[Agent] Sub-agent connection ${record.id} errored:`, error);
    return true;
  }

  async onRoute(context: LifecycleRouteContext): Promise<unknown> {
    const { payload } = context;
    if (!isDynamicAgentRouteMessage(payload)) {
      throw new Error("Unknown dynamic-agents route message");
    }
    switch (payload.type) {
      case "forward":
        return this.routeTo(payload.target, payload.envelope);
      case "init":
        return this.adoptAsChild(
          payload.name,
          payload.parentPath,
          payload.identityName
        );
      case "invoke":
        return this.invokeAt(payload.path, payload.method, payload.args);
      case "invoke:child":
        return this.invokeChild(
          payload.child.className,
          payload.child.name,
          payload.method,
          payload.args
        );
      case "invoke:path":
        return this.invokePath(payload.path, payload.method, payload.args);
      case "destroy":
        return this.destroyDescendant(payload.target);
      case "retire":
        return this.#retire(payload.prefix);
      case "keepalive:acquire":
        return this.#acquireKeepAlive(payload.owner);
      case "keepalive:release":
        return this.#releaseKeepAlive(payload.token);
      case "lease:register":
        return this.#registerLease(payload.owner, payload.id);
      case "lease:unregister":
        return this.#unregisterLease(payload.owner, payload.id);
      case "lease:check":
        return this.#checkLeaseAt(payload.owner);
      case "connection:send":
        return this.sendToConnection(payload.id, payload.message);
      case "connection:close":
        return this.closeConnection(payload.id, payload.code, payload.reason);
      case "connection:setState":
        return this.setConnectionState(payload.id, payload.state);
      case "connection:setTags":
        return this.setConnectionTags(payload.id, payload.tags);
      case "connection:metas":
        return this.connectionMetas(payload.owner);
      case "connection:broadcast":
        return this.broadcastToPath(
          payload.owner,
          payload.message,
          payload.without
        );
      case "ws:connect":
        return this.deliverConnect(payload.bridge, payload.meta);
      case "ws:message":
        return this.deliverMessage(
          payload.message,
          payload.bridge,
          payload.meta,
          payload.replyBridge
        );
      case "ws:close":
        return this.deliverClose(
          payload.code,
          payload.reason,
          payload.wasClean,
          payload.bridge,
          payload.meta
        );
    }
  }

  /** Drop root-owned mirrors (leases, keep-alive holds) for a retired subtree. */
  async onRouteRetired({ covers }: LifecycleRouteRetirement): Promise<void> {
    for (const row of this.#leaseRows()) {
      if (!covers(row.owner_path_key)) continue;
      this.#sql`
        DELETE FROM cf_agents_facet_runs
        WHERE owner_path_key = ${row.owner_path_key}
          AND run_id = ${row.run_id}
      `;
    }
    for (const [token, ownerKey] of this.#keepAliveTokens) {
      if (covers(ownerKey)) this.#keepAliveTokens.delete(token);
    }
    await this.#syncJobs();
  }

  async onJob({
    job
  }: LifecycleJobContext): Promise<LifecycleJobOutcome | undefined> {
    switch (job.fn) {
      case KEEP_ALIVE_JOB_ID:
        // Its only purpose is guaranteeing wakes while holds are outstanding.
        return this.#keepAliveTokens.size > 0
          ? { rescheduleAt: Date.now() + this.#keepAliveIntervalMs }
          : undefined;
      case LEASE_SWEEP_JOB_ID:
        await this.sweepLeases();
        return this.#leaseRows().length > 0
          ? { rescheduleAt: Date.now() + this.#keepAliveIntervalMs }
          : undefined;
      default:
        return undefined;
    }
  }

  dispose(): void {
    for (const record of ownedSockets(this.lifecycle.sockets)) {
      try {
        record.close(1001, "Durable Object destroyed");
      } catch {
        // Already closed or mid-handshake — nothing left to tear down.
      }
    }
  }

  // ── Resolution and identity ──────────────────────────────────────────

  /**
   * Resolve a child by class name and name: create or wake it, record it
   * in the registry, and establish its identity. Returns the raw stub.
   */
  async resolve(className: string, name: string): Promise<ChildStub> {
    const { facets, exports } = this.lifecycle;
    await this.lifecycle.ready();
    if (!facets.supported) {
      throw new Error(
        "Dynamic agents are not supported in this runtime — " +
          "`ctx.facets` / `ctx.exports` are unavailable. " +
          "Update to the latest `compatibility_date` in your wrangler.jsonc."
      );
    }
    if (camelCaseToKebabCase(className) === SUB_PREFIX) {
      // Any class whose kebab-cased name equals the `sub` URL separator
      // would make `/agents/.../sub/sub/...` ambiguous. `Sub`, `SUB`, and
      // `Sub_` all kebab-case to "sub" — catch them uniformly.
      throw new Error(
        `Sub-agent class name "${className}" kebab-cases to "${SUB_PREFIX}", ` +
          `which collides with the reserved URL separator — rename the ` +
          `class (e.g. "SubThing" or "Subtask").`
      );
    }
    const Cls = exports.durableObjectClass(className);
    if (!Cls) {
      throw new Error(
        `Sub-agent class "${className}" not found in worker exports. ` +
          `Make sure the class is exported from your worker entry point ` +
          `and that the export name matches the class name.`
      );
    }
    if (name.includes("\0")) {
      // Null char is reserved for the facet composite key delimiter.
      throw new Error(
        `Sub-agent name contains null character (\\0), which is reserved.`
      );
    }

    const childParentPath = this.selfPath;
    const childPath = [...childParentPath, { className, name }];

    // Path-v2 identities are scoped to the full logical path and addressed
    // through the root's namespace; legacy rows keep bare names.
    const rootClassName =
      this.#identity.parentPath[0]?.className ??
      this.lifecycle.object.className;
    const rootNamespace = exports.namespace(rootClassName);
    if (!rootNamespace) {
      // Minification is the most common cause in production builds:
      // aggressive bundlers rewrite class identifiers to short ids, so the
      // exports lookup misses. Detect that case and append a hint.
      const looksMinified = /^_*[a-z][a-z0-9]{0,2}$/.test(rootClassName);
      const minificationHint = looksMinified
        ? ` The class name "${rootClassName}" looks minified — make sure your bundler preserves class names (e.g. esbuild's \`keepNames: true\`).`
        : "";
      throw new Error(
        `Sub-agent bootstrap requires the root agent class "${rootClassName}" to be available as a Durable Object namespace, but ctx.exports["${rootClassName}"] is missing or doesn't expose idFromName.${minificationHint} Make sure the root agent class is exported under that class name and registered in your wrangler.jsonc durable_objects.bindings.`
      );
    }
    const identity = await this.#registry.identity(className, name, childPath);
    const facetId = rootNamespace.idFromName(identity.name);
    const stub = facets.get(facetKey(className, name), () => ({
      class: Cls,
      id: facetId
    })) as unknown as ChildStub;

    // Record before initialization so a successfully-initialized child is
    // not left without identity metadata if the parent is interrupted after
    // the child RPC returns, and so callbacks routed through the registry
    // can find the in-flight child. Roll back only rows this call created.
    this.#registry.record(className, name, identity);
    try {
      // Never carry the parent's live request or connection into the
      // child's bootstrap RPC.
      await runWithoutCurrentAgent(() =>
        stub._cf_lifecycle({
          capability: DYNAMIC_AGENTS_CAPABILITY_ID,
          source: this.#routeAddress(),
          payload: {
            type: "init",
            name,
            parentPath: childParentPath,
            identityName: identity.name
          } satisfies DynamicAgentRouteMessage,
          bootstrap: true
        })
      );
    } catch (error) {
      if (!identity.existing) this.#registry.forget(className, name);
      throw error;
    }
    return stub;
  }

  /**
   * Establish this object's identity as a child. Delivered before startup
   * for a fresh child, so the host's own startup observes it.
   */
  async adoptAsChild(
    name: string,
    parentPath: ReadonlyArray<AgentPathStep>,
    identityName = name
  ): Promise<void> {
    const routedName = this.lifecycle.object.name();
    if (routedName !== identityName) {
      throw new Error(
        `Facet bootstrap mismatch: expected routed identity "${identityName}" but got "${routedName}". ` +
          `This usually means the parent passed the wrong id to ctx.facets.get().`
      );
    }
    this.#identity = {
      isChild: true,
      childName: name,
      parentPath: [...parentPath]
    };
    const { storage } = this.lifecycle;
    await Promise.all([
      storage.put(IS_CHILD_STORAGE_KEY, true),
      storage.put(CHILD_NAME_STORAGE_KEY, name),
      storage.put(PARENT_PATH_STORAGE_KEY, [...parentPath])
    ]);
    // A fresh child was reached over native RPC, which bypasses fetch; start
    // it now so the host's `onStart` runs with the identity in place.
    await this.lifecycle.ready();
  }

  async #restoreIdentity(): Promise<void> {
    const { storage } = this.lifecycle;
    const isChild = await storage.get<boolean>(IS_CHILD_STORAGE_KEY);
    if (!isChild) return;
    const childName = await storage.get<string>(CHILD_NAME_STORAGE_KEY);
    const parentPath = await storage.get<unknown>(PARENT_PATH_STORAGE_KEY);
    this.#identity = {
      isChild: true,
      childName: typeof childName === "string" ? childName : undefined,
      parentPath: isValidParentPath(parentPath) ? parentPath : []
    };
  }

  async #assertHostAperture(): Promise<void> {
    const present = await this.lifecycle.runInHostContext(() => {
      const host = getCurrentAgent().agent as
        | { _cf_lifecycle?: unknown }
        | undefined;
      return typeof host?._cf_lifecycle === "function";
    });
    if (!present) {
      throw new Error(
        `${this.lifecycle.object.className} installs DynamicAgents but does not expose the routing aperture. Add:\n` +
          "  _cf_lifecycle(envelope: LifecycleRouteEnvelope) { return this.lifecycle.route(envelope); }"
      );
    }
  }

  // ── Routing ──────────────────────────────────────────────────────────

  #routeAddress(): LifecycleRouteAddress | undefined {
    return this.isChild ? routeAddressForPath(this.selfPath) : undefined;
  }

  #envelope(payload: DynamicAgentRouteMessage): LifecycleRouteEnvelope {
    return {
      capability: DYNAMIC_AGENTS_CAPABILITY_ID,
      source: this.#routeAddress(),
      payload
    };
  }

  #rootStub(): ChildStub {
    const root = this.#identity.parentPath[0];
    if (!root) throw new Error("Facet routing requires a root parent.");
    const namespace = this.lifecycle.exports.namespace(root.className);
    if (!namespace) {
      throw new Error(
        `Unable to resolve root "${root.className}" for facet routing.`
      );
    }
    return namespace.get(
      namespace.idFromName(root.name)
    ) as unknown as ChildStub;
  }

  #rootResolvesToSelf(): boolean {
    const root = this.#identity.parentPath[0];
    if (!root) return false;
    const namespace = this.lifecycle.exports.namespace(root.className);
    if (!namespace) return false;
    return this.lifecycle.object.isSelf(namespace.idFromName(root.name));
  }

  #sendToRoot(envelope: LifecycleRouteEnvelope): Promise<unknown> {
    if (!this.isChild) return this.#deliverLocal(envelope);
    return this.#rootStub()._cf_lifecycle(envelope);
  }

  /** Send a message to the root's DynamicAgents (or handle it locally at the root). */
  #sendRoot(message: DynamicAgentRouteMessage): Promise<unknown> {
    return this.#sendToRoot(this.#envelope(message));
  }

  #deliverLocal(envelope: LifecycleRouteEnvelope): Promise<unknown> {
    if (!this.#inbound) {
      throw new Error(
        "DynamicAgents must be installed with Lifecycle.use() before use"
      );
    }
    return this.#inbound.deliver(envelope);
  }

  /** Route an envelope to the object at `target`, one hop at a time. */
  async routeTo(
    target: LifecycleRouteAddress,
    envelope: LifecycleRouteEnvelope
  ): Promise<unknown> {
    let targetPath: AgentPathStep[];
    try {
      targetPath = JSON.parse(target.data) as AgentPathStep[];
    } catch {
      throw new Error("Lifecycle route target is not a valid Agent path");
    }
    const selfPath = this.selfPath;
    if (!isSameAgentPathPrefix(selfPath, targetPath)) {
      throw new Error(
        `Lifecycle route does not descend from ${JSON.stringify(selfPath)}.`
      );
    }
    if (selfPath.length === targetPath.length) {
      return this.#deliverLocal(envelope);
    }
    const next = targetPath[selfPath.length];
    if (!this.#registry.has(next.className, next.name)) {
      // A stale route: the next hop was deleted. Retire what the root
      // still mirrors for it and report the message undeliverable.
      await this.#retire(targetPath.slice(0, selfPath.length + 1));
      return false;
    }
    const child = await this.resolve(next.className, next.name);
    if (selfPath.length + 1 === targetPath.length) {
      return child._cf_lifecycle(envelope);
    }
    return child._cf_lifecycle(
      this.#envelope({ type: "forward", target, envelope })
    );
  }

  // ── Invocation ───────────────────────────────────────────────────────

  #invokeLocal(method: string, args: unknown[]): Promise<unknown> {
    return this.lifecycle.runInHostContext(() => {
      const host = getCurrentAgent().agent as
        | Record<string, unknown>
        | undefined;
      const fn = host?.[method];
      // Match real DO-stub RPC semantics: refuse JS-internal probes
      // (`constructor`, `toString`, symbol keys, thenable checks, …) and
      // anything inherited from `Object.prototype`, so a routed invocation
      // cannot reach a method surface a top-level stub would deny.
      if (
        !host ||
        isInternalJsStubProp(method) ||
        method in Object.prototype ||
        typeof fn !== "function"
      ) {
        throw new Error(
          `Workflow origin method "${method}" is not callable on ${this.lifecycle.object.className}.`
        );
      }
      return (fn as (...methodArgs: unknown[]) => unknown).apply(host, args);
    });
  }

  // ── Teardown ─────────────────────────────────────────────────────────

  /**
   * Destroy a strict descendant: retire the root's mirrors for its subtree,
   * then walk down to its immediate parent, which wipes its storage.
   */
  async destroyDescendant(
    targetPath: ReadonlyArray<AgentPathStep>
  ): Promise<void> {
    const selfPath = this.selfPath;
    if (targetPath.length === 0) {
      throw new Error("destroyDescendant: target path must not be empty.");
    }
    if (selfPath.length >= targetPath.length) {
      throw new Error("destroyDescendant: target must be a strict descendant.");
    }
    if (!isSameAgentPathPrefix(selfPath, targetPath)) {
      throw new Error(
        "destroyDescendant: target path does not descend from this object."
      );
    }
    // The root owns every mirror; retire the target's prefix upfront so no
    // intermediate hop needs a round trip back.
    if (!this.isChild) await this.#retire(targetPath);

    if (selfPath.length === targetPath.length - 1) {
      const target = targetPath[targetPath.length - 1];
      try {
        this.lifecycle.facets.delete(facetKey(target.className, target.name));
      } catch {
        // The child was never spawned or is already gone.
      }
      this.#registry.forget(target.className, target.name);
      return;
    }
    const next = targetPath[selfPath.length];
    if (!this.#registry.has(next.className, next.name)) return;
    const child = await this.resolve(next.className, next.name);
    await child._cf_lifecycle(
      this.#envelope({ type: "destroy", target: targetPath })
    );
  }

  async #retire(prefix: ReadonlyArray<AgentPathStep>): Promise<void> {
    if (this.isChild) {
      await this.#sendRoot({ type: "retire", prefix });
      return;
    }
    const address = routeAddressForPath(prefix);
    if (!address) return;
    await this.lifecycle.routes.retire({
      address,
      covers: (ownerKey) => ownerKeyUnder(address.key, ownerKey)
    });
  }

  // ── Keep-alive and leases (root-owned) ───────────────────────────────

  get #keepAliveIntervalMs(): number {
    return this.#options.keepAliveIntervalMs ?? DEFAULT_KEEP_ALIVE_INTERVAL_MS;
  }

  async #acquireKeepAlive(
    owner: ReadonlyArray<AgentPathStep>
  ): Promise<string> {
    const ownerKey = agentPathKey(owner) ?? "unknown";
    const token = `${ownerKey}:${nanoid(9)}`;
    this.#keepAliveTokens.set(token, ownerKey);
    if (this.#keepAliveTokens.size === 1) await this.#syncJobs();
    return token;
  }

  async #releaseKeepAlive(token: string): Promise<void> {
    if (!this.#keepAliveTokens.delete(token)) return;
    if (this.#keepAliveTokens.size === 0) await this.#syncJobs();
  }

  #ensureLeaseTable(): void {
    this.#sql`
      CREATE TABLE IF NOT EXISTS cf_agents_facet_runs (
        owner_path TEXT NOT NULL,
        owner_path_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (owner_path_key, run_id)
      )
    `;
    this.#sql`
      CREATE INDEX IF NOT EXISTS idx_facet_runs_owner_path_key
      ON cf_agents_facet_runs(owner_path_key)
    `;
  }

  #leaseRows(): FacetRunStorageRow[] {
    return this.#sql<FacetRunStorageRow>`
      SELECT owner_path, owner_path_key, run_id, created_at
      FROM cf_agents_facet_runs
      ORDER BY created_at ASC
    `;
  }

  async #registerLease(
    owner: ReadonlyArray<AgentPathStep>,
    id: string
  ): Promise<void> {
    const ownerKey = agentPathKey(owner);
    if (!ownerKey) {
      throw new Error("A lease requires a non-empty owner path.");
    }
    this.#sql`
      INSERT OR REPLACE INTO cf_agents_facet_runs
        (owner_path, owner_path_key, run_id, created_at)
      VALUES
        (${JSON.stringify(owner)}, ${ownerKey}, ${id}, ${Date.now()})
    `;
    await this.#ensureLeaseSweep();
  }

  async #unregisterLease(
    owner: ReadonlyArray<AgentPathStep>,
    id: string
  ): Promise<void> {
    this.#sql`
      DELETE FROM cf_agents_facet_runs
      WHERE owner_path_key IS ${agentPathKey(owner)}
        AND run_id = ${id}
    `;
    await this.#syncJobs();
  }

  async #ensureLeaseSweep(): Promise<void> {
    if (this.lifecycle.jobs.get(LEASE_SWEEP_JOB_ID)) return;
    await this.lifecycle.jobs.push({
      id: LEASE_SWEEP_JOB_ID,
      fn: LEASE_SWEEP_JOB_ID,
      time: Date.now() + this.#keepAliveIntervalMs
    });
  }

  /** Re-derive the keep-alive and lease-sweep jobs from current state. */
  async #syncJobs(): Promise<void> {
    const { jobs } = this.lifecycle;
    if (this.#keepAliveTokens.size > 0) {
      await jobs.push({
        id: KEEP_ALIVE_JOB_ID,
        fn: KEEP_ALIVE_JOB_ID,
        time: Date.now() + this.#keepAliveIntervalMs
      });
    } else if (jobs.get(KEEP_ALIVE_JOB_ID)) {
      await jobs.cancel(KEEP_ALIVE_JOB_ID);
    }
    if (this.#leaseRows().length > 0) {
      await this.#ensureLeaseSweep();
    } else if (jobs.get(LEASE_SWEEP_JOB_ID)) {
      await jobs.cancel(LEASE_SWEEP_JOB_ID);
    }
  }

  async #sweepLeases(): Promise<void> {
    // Only the root owns the physical alarm and the lease index.
    if (this.isChild) return;
    const firstRowByOwner = new Map<string, FacetRunStorageRow>();
    for (const row of this.#leaseRows()) {
      if (!firstRowByOwner.has(row.owner_path_key)) {
        firstRowByOwner.set(row.owner_path_key, row);
      }
    }
    for (const row of firstRowByOwner.values()) {
      let owner: AgentPathStep[];
      try {
        owner = JSON.parse(row.owner_path) as AgentPathStep[];
      } catch (error) {
        console.warn(
          `[Agent] Corrupted facet fiber owner path for ${row.owner_path_key}; pruning stale lease.`,
          error
        );
        this.#deleteLeases(row.owner_path_key);
        continue;
      }
      try {
        const remaining = await this.#checkLeaseAt(owner);
        if (remaining === 0) this.#deleteLeases(row.owner_path_key);
      } catch (error) {
        // Keep the lease so a transient failure (e.g. child init error)
        // is retried on the next heartbeat.
        console.error(
          `[Agent] Facet fiber recovery check failed for ${row.owner_path_key}:`,
          error
        );
      }
    }
  }

  #deleteLeases(ownerKey: string): void {
    this.#sql`
      DELETE FROM cf_agents_facet_runs
      WHERE owner_path_key = ${ownerKey}
    `;
  }

  /** Ask the object at `owner` to recover its leased work; how many leases remain. */
  async #checkLeaseAt(owner: ReadonlyArray<AgentPathStep>): Promise<number> {
    const selfPath = this.selfPath;
    if (!isSameAgentPathPrefix(selfPath, owner)) {
      throw new Error(
        `Facet fiber owner path does not descend from ${JSON.stringify(selfPath)}.`
      );
    }
    if (selfPath.length === owner.length) {
      const remaining = await this.lifecycle.runInHostContext(
        () => this.#options.checkLeases?.() ?? 0
      );
      return Number(remaining) || 0;
    }
    const next = owner[selfPath.length];
    // The child was deleted or its registry cleared: nothing to recover.
    if (!this.#registry.has(next.className, next.name)) return 0;
    const child = await this.resolve(next.className, next.name);
    const remaining = await child._cf_lifecycle(
      this.#envelope({ type: "lease:check", owner })
    );
    return Number(remaining) || 0;
  }

  // ── Root-owned sockets ───────────────────────────────────────────────

  /** Send to every root-owned connection addressed exactly to `owner`. */
  async broadcastToPath(
    owner: ReadonlyArray<AgentPathStep>,
    message: WSMessage,
    without?: string[]
  ): Promise<void> {
    if (this.isChild) {
      await this.#connections.routeBroadcast(owner, message, without);
      return;
    }
    for (const record of ownedSockets(this.lifecycle.sockets)) {
      if (without?.includes(record.id)) continue;
      const target = this.#pathFromOuterUri(record.outer);
      if (!target || !isSameAgentPath(target.path, owner)) continue;
      record.send(message);
    }
  }

  /** The parent's view of every root-owned connection addressed to `owner`. */
  async connectionMetas(
    owner: ReadonlyArray<AgentPathStep>
  ): Promise<DynamicAgentConnectionMeta[]> {
    const metas: DynamicAgentConnectionMeta[] = [];
    for (const record of ownedSockets(this.lifecycle.sockets)) {
      const target = this.#pathFromOuterUri(record.outer, owner);
      if (!target) continue;
      metas.push({
        id: record.id,
        uri: target.uri,
        tags: [...record.tags],
        state: record.state
      });
    }
    return metas;
  }

  async sendToConnection(id: string, message: WSMessage): Promise<void> {
    ownedSocketById(this.lifecycle.sockets, id)?.send(message);
  }

  async closeConnection(
    id: string,
    code?: number,
    reason?: string
  ): Promise<void> {
    ownedSocketById(this.lifecycle.sockets, id)?.close(code, reason);
  }

  async setConnectionState(id: string, state: unknown): Promise<unknown> {
    const record = ownedSocketById(this.lifecycle.sockets, id);
    if (!record) return null;
    return record.setState(state);
  }

  async setConnectionTags(id: string, tags: readonly string[]): Promise<void> {
    ownedSocketById(this.lifecycle.sockets, id)?.setTags(tags);
  }

  #metaFor(
    record: RootSocketRecord,
    match: SubAgentPathMatch,
    request?: Request
  ): DynamicAgentConnectionMeta {
    const uri = new URL(request?.url ?? record.outer);
    uri.pathname = match.remainingPath;
    return {
      id: record.id,
      uri: uri.toString(),
      tags: [...record.tags],
      state: record.state,
      requestHeaders: request ? [...request.headers] : undefined
    };
  }

  /** The live-frame bridge for a parent-side view of a connection. */
  #bridgeFor(
    ops: DynamicAgentConnectionOps,
    connectionId?: string
  ): DynamicAgentConnectionBridge {
    // A child-to-parent RPC callback starts a fresh async context. Capture
    // the upstream bridge explicitly while this forwarding frame is active.
    const upstream =
      this.isChild && connectionId !== undefined
        ? this.#connections.activeBridge(connectionId)
        : undefined;
    return new DynamicAgentConnectionBridge(ops, (owner, message, without) =>
      upstream
        ? this.#connections.routeBroadcast(owner, message, without, upstream)
        : this.broadcastToPath(owner, message, without)
    );
  }

  /** Forward a platform wake on a root-owned socket to the child it targets. */
  async #forwardFrame(
    record: RootSocketRecord,
    frame: ForwardedFrame
  ): Promise<void> {
    const match = this.#matchChild(record.outer);
    if (!match) {
      record.close(1011, "Sub-agent unavailable");
      return;
    }
    const child = await this.resolve(match.childClass, match.childName);
    await child._cf_lifecycle(
      this.#envelope({
        ...frame,
        meta: this.#metaFor(record, match),
        bridge: this.#bridgeFor(record)
      })
    );
  }

  // ── Bridged connections (child side) ─────────────────────────────────

  get #connections(): ChildConnectionRouter {
    this.#connectionsInstance ??= new ChildConnectionRouter({
      waitUntil: (work) => this.lifecycle.waitUntil(work),
      sendToRoot: (message) => this.#sendRoot(message)
    });
    return this.#connectionsInstance;
  }

  /** Deliver a forwarded connect to this object's WebSockets, or one hop deeper. */
  async deliverConnect(
    bridge: DynamicAgentConnectionBridgeLike,
    meta: DynamicAgentConnectionMeta
  ): Promise<void> {
    await this.#connections.runWithBridge(bridge, meta.id, async () => {
      const request = new Request(meta.uri ?? "http://placeholder/", {
        headers: meta.requestHeaders
      });
      if (await this.#forwardDeeper(meta, request, { type: "ws:connect" })) {
        return;
      }
      await this.#deliver({
        type: "bridged:connect",
        meta: bridgedMeta(meta),
        link: this.#connections.link(meta.id),
        request
      });
      // Publish onConnect state to the root before the first client frame
      // can replace the bridged connection's state with root-owned metadata.
      await this.#connections.operationTail(meta.id);
    });
  }

  /** Deliver a forwarded message to this object's WebSockets, or one hop deeper. */
  async deliverMessage(
    message: WSMessage,
    bridge: DynamicAgentConnectionBridgeLike,
    meta: DynamicAgentConnectionMeta,
    replyBridge:
      | DynamicAgentConnectionBridge
      | undefined = bridge as DynamicAgentConnectionBridge
  ): Promise<void> {
    const replyContext: DynamicAgentRpcReplyInvocationContext = {
      bridge: replyBridge
    };
    try {
      await dynamicAgentRpcReplyContext.run(replyContext, () =>
        this.#connections.runWithBridge(bridge, meta.id, async () => {
          if (
            await this.#forwardDeeper(meta, undefined, {
              type: "ws:message",
              message,
              replyBridge
            })
          ) {
            return;
          }
          await this.#deliver({
            type: "bridged:message",
            meta: bridgedMeta(meta),
            link: this.#connections.link(meta.id),
            message
          });
        })
      );
    } finally {
      replyContext.bridge = undefined;
    }
  }

  /** Deliver a forwarded close to this object's WebSockets, or one hop deeper. */
  async deliverClose(
    code: number,
    reason: string,
    wasClean: boolean,
    bridge: DynamicAgentConnectionBridgeLike,
    meta: DynamicAgentConnectionMeta
  ): Promise<void> {
    await this.#connections.runWithBridge(bridge, meta.id, async () => {
      if (
        await this.#forwardDeeper(meta, undefined, {
          type: "ws:close",
          code,
          reason,
          wasClean
        })
      ) {
        return;
      }
      await this.#deliver({
        type: "bridged:close",
        meta: bridgedMeta(meta),
        link: this.#connections.link(meta.id),
        code,
        reason,
        wasClean
      });
    });
  }

  /**
   * When a bridged connection is addressed to one of this object's own
   * children, forward the frame one hop deeper instead of delivering it
   * here. Connects run the child gate at every hop.
   */
  async #forwardDeeper(
    meta: DynamicAgentConnectionMeta,
    request: Request | undefined,
    frame: ForwardedFrame
  ): Promise<boolean> {
    if (!meta.uri) return false;
    const match = this.#matchChild(meta.uri);
    if (!match) return false;

    let forwardRequest = request;
    if (request && frame.type === "ws:connect") {
      const decision = await this.#gate(request, match);
      if (decision instanceof Response) {
        this.#connections
          .link(meta.id)
          .close(1008, "Sub-agent connection rejected");
        return true;
      }
      forwardRequest = decision instanceof Request ? decision : request;
    }

    const child = await this.resolve(match.childClass, match.childName);
    const uri = new URL(forwardRequest?.url ?? meta.uri);
    uri.pathname = match.remainingPath;
    await child._cf_lifecycle(
      this.#envelope({
        ...frame,
        meta: {
          id: meta.id,
          uri: uri.toString(),
          tags: meta.tags,
          state: meta.state,
          requestHeaders: forwardRequest
            ? [...forwardRequest.headers]
            : undefined
        },
        bridge: this.#bridgeFor(this.#connections.link(meta.id), meta.id)
      })
    );
    return true;
  }

  async #deliver(payload: WebSocketsRouteMessage): Promise<void> {
    try {
      await this.#deliverLocal({
        capability: "websockets",
        source: this.#routeAddress(),
        payload
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("cannot receive routed messages")
      ) {
        throw new Error(
          `${this.lifecycle.object.className} received a WebSocket connection but has no WebSockets capability. ` +
            "Install `new WebSockets({ handlers })` on it to accept connections forwarded by its parent."
        );
      }
      throw error;
    }
  }

  /**
   * Re-read the parent's view of every connection addressed to this
   * child into its WebSockets capability.
   */
  async hydrateConnectionsFromRoot(): Promise<void> {
    await this.lifecycle.ready();
    await this.#hydrate({ deliverEmpty: true });
  }

  /** Forget every bridged connection until the next hydration. */
  async clearVirtualConnections(): Promise<void> {
    await this.lifecycle.ready();
    await this.#deliver({ type: "bridged:sync", connections: [], reset: true });
  }

  async #hydrate({ deliverEmpty }: { deliverEmpty: boolean }): Promise<void> {
    if (!this.isChild || this.#identity.parentPath.length === 0) return;
    if (this.#rootResolvesToSelf()) {
      // The root stub would resolve back to this blocked object during
      // startup; a child sees no root-owned sockets locally, so skip.
      return;
    }
    let metas: DynamicAgentConnectionMeta[];
    try {
      metas = (await this.#sendRoot({
        type: "connection:metas",
        owner: this.selfPath
      })) as DynamicAgentConnectionMeta[];
    } catch (error) {
      console.warn(
        "[Agent] Unable to hydrate sub-agent WebSocket connections:",
        error
      );
      return;
    }
    if (metas.length === 0 && !deliverEmpty) return;
    const sync: WebSocketsRouteMessage = {
      type: "bridged:sync",
      reset: true,
      connections: metas.map((meta) => ({
        meta: bridgedMeta(meta),
        link: this.#connections.link(meta.id)
      }))
    };
    // Queued until startup completes when called from onStart; the host
    // then observes its connections before the first frame lands.
    const delivered = this.#deliver(sync);
    if (this.lifecycle.starting()) {
      delivered.catch((error) => {
        console.warn(
          "[Agent] Unable to hydrate sub-agent WebSocket connections:",
          error
        );
      });
      return;
    }
    await delivered;
  }

  // ── Requests and gating ──────────────────────────────────────────────

  async #gate(
    request: Request,
    match: SubAgentPathMatch
  ): Promise<Request | Response | undefined | void> {
    const child: DynamicAgentRef = {
      className: match.childClass,
      name: match.childName
    };
    return (await this.lifecycle.runInHostContext(
      () => this.#options.onBeforeChild?.(request, child),
      { request }
    )) as Request | Response | undefined | void;
  }

  /**
   * Resolve the child for `match` and forward the request to it with
   * `/sub/{class}/{name}` stripped.
   */
  async #forwardRequest(
    request: Request,
    match: SubAgentPathMatch
  ): Promise<Response> {
    let child: ChildStub;
    try {
      child = await this.resolve(match.childClass, match.childName);
    } catch (error) {
      // Keep the wire response terse: don't leak the parent's view of
      // exports or internal error text over HTTP. The full error is still
      // available to developers via worker logs.
      const message = error instanceof Error ? error.message : String(error);
      console.error("[agents] sub-agent route failed:", message);
      if (/null character/i.test(message) || /reserved/i.test(message)) {
        return new Response("Bad Request", { status: 400 });
      }
      return new Response("Not Found", { status: 404 });
    }

    const rewritten = new URL(request.url);
    rewritten.pathname = match.remainingPath;
    const init: RequestInit = {
      method: request.method,
      headers: new Headers(request.headers)
    };
    // Hand the body through as a stream. Reading it here materialises the
    // entire body in this isolate, ahead of any application-level intake
    // limit, and re-materialises it once per `/sub/` hop — see #2015.
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }
    return child.fetch(new Request(rewritten, init));
  }

  // ── Paths ────────────────────────────────────────────────────────────

  #knownClasses(): readonly string[] | undefined {
    const { exports } = this.lifecycle;
    return exports.supported ? exports.names() : undefined;
  }

  /**
   * The first `/sub/` hop in `url` below this object. A URL that still
   * names this object's own segment is re-parsed past it.
   */
  #matchChild(url: string): SubAgentPathMatch | null {
    const knownClasses = this.#knownClasses();
    let match = parseSubAgentPath(url, { knownClasses });
    if (!match) return null;
    if (
      match.childClass === this.lifecycle.object.className &&
      match.childName === this.name
    ) {
      const tail = new URL(url);
      tail.pathname = match.remainingPath;
      match = parseSubAgentPath(tail.toString(), { knownClasses });
    }
    return match;
  }

  #pathFromOuterUri(
    outerUri: string,
    stopAt?: ReadonlyArray<AgentPathStep>
  ): { path: ReadonlyArray<AgentPathStep>; uri: string } | null {
    const knownClasses = this.#knownClasses();
    const path: AgentPathStep[] = [...this.selfPath];
    let currentUrl = outerUri;
    while (true) {
      const match = parseSubAgentPath(currentUrl, { knownClasses });
      if (!match) break;
      path.push({ className: match.childClass, name: match.childName });
      const rewritten = new URL(currentUrl);
      rewritten.pathname = match.remainingPath;
      currentUrl = rewritten.toString();
      if (stopAt && isSameAgentPath(path, stopAt)) {
        return { path, uri: currentUrl };
      }
    }
    if (path.length === this.selfPath.length) return null;
    if (stopAt) return null;
    return { path, uri: currentUrl };
  }

  // ── Storage ──────────────────────────────────────────────────────────

  get #registry(): DynamicAgentRegistry {
    this.#registryInstance ??= new DynamicAgentRegistry(
      registrySqlHost(this.lifecycle.storage)
    );
    return this.#registryInstance;
  }

  get #sql(): DynamicAgentRegistrySqlHost["sql"] {
    return registrySqlHost(this.lifecycle.storage).sql;
  }
}

function facetKey(className: string, name: string): string {
  // Composite key: class name + NUL + facet name, so two classes can share
  // the same user-facing name.
  return `${className}\0${name}`;
}

/** Dispatch one RPC method on a stub. */
export async function invokeStubMethod(
  stub: unknown,
  className: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  // Must call `handle[method](...)` in one expression — extracting via
  // `const fn = handle[method]; fn.apply(handle, args)` breaks the workerd
  // RpcProperty binding.
  const handle = stub as Record<string, (...a: unknown[]) => Promise<unknown>>;
  if (typeof handle[method] !== "function") {
    throw new Error(`Method "${method}" not found on ${className}.`);
  }
  return await handle[method](...args);
}
