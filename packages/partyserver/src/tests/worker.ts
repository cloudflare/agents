import { DurableObject } from "cloudflare:workers";

import { routePartykitRequest, Server } from "../index";

import type {
  Connection,
  ConnectionContext,
  DurableObjectLifecycleComponent,
  WSMessage
} from "../index";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export type Env = {
  Stateful: DurableObjectNamespace<Stateful>;
  OnStartServer: DurableObjectNamespace<OnStartServer>;
  HibernatingOnStartServer: DurableObjectNamespace<HibernatingOnStartServer>;
  AlarmServer: DurableObjectNamespace<AlarmServer>;
  AlarmNameServer: DurableObjectNamespace<AlarmNameServer>;
  NoNameServer: DurableObjectNamespace<NoNameServer>;
  HeaderOnlyOnStartServer: DurableObjectNamespace<HeaderOnlyOnStartServer>;
  SetNameBootstrapServer: DurableObjectNamespace<SetNameBootstrapServer>;
  FacetLikeBootstrapServer: DurableObjectNamespace<FacetLikeBootstrapServer>;
  NameInConstructorServer: DurableObjectNamespace<NameInConstructorServer>;
  Mixed: DurableObjectNamespace<Mixed>;
  ConfigurableState: DurableObjectNamespace<ConfigurableState>;
  ConfigurableStateInMemory: DurableObjectNamespace<ConfigurableStateInMemory>;
  StateRoundTrip: DurableObjectNamespace<StateRoundTrip>;
  CorsServer: DurableObjectNamespace<CorsServer>;
  CustomCorsServer: DurableObjectNamespace<CustomCorsServer>;
  FailingOnStartServer: DurableObjectNamespace<FailingOnStartServer>;
  HibernatingNameInMessage: DurableObjectNamespace<HibernatingNameInMessage>;
  TagsServer: DurableObjectNamespace<TagsServer>;
  TagsServerInMemory: DurableObjectNamespace<TagsServerInMemory>;
  UriServer: DurableObjectNamespace<UriServer>;
  UriServerInMemory: DurableObjectNamespace<UriServerInMemory>;
  PropsServer: DurableObjectNamespace<PropsServer>;
  FacetParent: DurableObjectNamespace<FacetParent>;
  // FacetChild has no binding — it's reached via ctx.facets.get() from
  // FacetParent's isolate, just like Cloudflare Agents sub-agents.
  RawAlarmDO: DurableObjectNamespace<RawAlarmDO>;
  CloseHandshakeHibernating: DurableObjectNamespace<CloseHandshakeHibernating>;
  CloseHandshakeInMemory: DurableObjectNamespace<CloseHandshakeInMemory>;
  ThrowingCloseHibernating: DurableObjectNamespace<ThrowingCloseHibernating>;
  ThrowingCloseInMemory: DurableObjectNamespace<ThrowingCloseInMemory>;
  UserClosesInOnCloseHibernating: DurableObjectNamespace<UserClosesInOnCloseHibernating>;
  UserClosesInOnCloseInMemory: DurableObjectNamespace<UserClosesInOnCloseInMemory>;
  BinaryTypeProbe: DurableObjectNamespace<BinaryTypeProbe>;
  LifecycleProbe: DurableObjectNamespace<LifecycleProbe>;
};

/**
 * Reports the server-side `connection.binaryType` back to the client in
 * `onConnect`. Used by the compat-matrix suite to lock the ArrayBuffer binary
 * delivery contract across compatibility dates: on dates >= 2026-03-17 the
 * `websocket_standard_binary_type` flag would otherwise default this to "blob".
 * Non-hibernating so it exercises the in-memory accept path where the pin lives.
 */
export class BinaryTypeProbe extends Server {
  onConnect(connection: Connection): void {
    connection.send(connection.binaryType);
  }
}

class HibernatingServer extends Server {
  static options: typeof Server.options = {
    hibernate: true
  };
}

export class Stateful extends HibernatingServer {
  static options = {};

  onConnect(
    connection: Connection,
    _ctx: ConnectionContext
  ): void | Promise<void> {
    connection.send(
      JSON.stringify({
        name: this.name
      })
    );
  }

  onRequest(
    _request: Request<unknown, CfProperties<unknown>>
  ): Response | Promise<Response> {
    return Response.json({
      name: this.name
    });
  }
}

export class OnStartServer extends Server {
  counter = 0;
  async onStart() {
    // this stray assert is simply to make sure .name is available
    // inside onStart, it should throw if not
    assert(this.name, "name is not available inside onStart");
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        this.counter++;
        resolve();
      }, 300);
    });
  }
  onConnect(connection: Connection) {
    connection.send(this.counter.toString());
  }
  onRequest(
    _request: Request<unknown, CfProperties<unknown>>
  ): Response | Promise<Response> {
    return new Response(this.counter.toString());
  }
  /**
   * Custom user-defined RPC. Used to verify that `getServerByName()`
   * awaits `onStart()` before returning, so that state initialized there
   * (here, `counter`) is observable via native DO RPCs (which don't pass
   * through `Server.fetch()` and thus don't trigger initialization).
   */
  async getCounter(): Promise<number> {
    return this.counter;
  }
}

/**
 * Like OnStartServer but with hibernate: true.
 * Tests that setName properly initializes the server in the
 * hibernating websocket handler path (webSocketMessage, webSocketClose, etc.)
 */
export class HibernatingOnStartServer extends Server {
  static options = {
    hibernate: true
  };

  counter = 0;

  async onStart() {
    assert(this.name, "name is not available inside onStart");
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        this.counter++;
        resolve();
      }, 300);
    });
  }

  onConnect(connection: Connection) {
    connection.send(this.counter.toString());
  }

  onMessage(connection: Connection, _message: WSMessage) {
    connection.send(`counter:${this.counter}`);
  }

  onRequest(): Response {
    return new Response(this.counter.toString());
  }
}

/**
 * Tests that alarm() properly initializes the server
 * without the redundant blockConcurrencyWhile wrapper.
 */
export class AlarmServer extends Server {
  static options = {
    hibernate: true
  };

  counter = 0;
  alarmCount = 0;

  async onStart() {
    this.counter++;
  }

  onAlarm() {
    this.alarmCount++;
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.searchParams.get("setAlarm")) {
      // Schedule alarm far in the future so it won't auto-fire
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return new Response("alarm set");
    }
    return Response.json({
      counter: this.counter,
      alarmCount: this.alarmCount
    });
  }
}

/**
 * Multipurpose test DO for name persistence scenarios.
 * Supports seeding storage directly (bypassing setName), reading back
 * what this.name returned in onStart/onAlarm, and direct fetch without
 * the x-partykit-room header.
 */
export class AlarmNameServer extends Server {
  static options = {
    hibernate: true
  };

  alarmName: string | null = null;
  onStartName: string | null = null;
  nameWasCold = false;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Seed the legacy __ps_name storage record and schedule an alarm.
    // Simulates a DO that was named by an older version of PartyServer
    // and had an alarm scheduled before 2026-03-15 (where `ctx.id.name`
    // is not carried into the alarm handler). When the DO is addressed
    // via `newUniqueId()` the storage fallback inside alarm() is the
    // only way to recover the name.
    if (url.searchParams.get("seed")) {
      const name = url.searchParams.get("name");
      if (!name) {
        return new Response("name is required", { status: 400 });
      }
      await this.ctx.storage.put("__ps_name", name);
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return new Response("seeded");
    }

    // Try calling setName() with a different name from within the DO and
    // return the error message. Used by the test that verifies setName
    // throws on a ctx.id.name mismatch. Running this inside the DO keeps
    // the rejection off the RPC boundary so vitest-pool-workers doesn't
    // report it as an "unhandled error" alongside the expected failure.
    const mismatchName = url.searchParams.get("setNameMismatch");
    if (mismatchName) {
      try {
        await this.setName(mismatchName);
        return Response.json({ threw: false });
      } catch (e) {
        return Response.json({
          threw: true,
          message: e instanceof Error ? e.message : String(e)
        });
      }
    }

    return super.fetch(request);
  }

  async onStart() {
    try {
      this.onStartName = this.name;
    } catch {
      this.onStartName = null;
    }
  }

  onAlarm() {
    try {
      this.alarmName = this.name;
    } catch {
      this.alarmName = null;
    }
  }

  async readStoredName(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("__ps_name");
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.searchParams.get("setAlarm")) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return new Response("alarm set");
    }
    return Response.json({
      name: this.name,
      alarmName: this.alarmName,
      onStartName: this.onStartName,
      nameWasCold: this.nameWasCold
    });
  }
}

/**
 * Minimal DO used to verify that `this.name` is available automatically
 * from `ctx.id.name` without any prior `setName()`/header plumbing.
 */
export class NoNameServer extends Server {
  static options = { hibernate: true };

  async onStart() {
    // no-op
  }

  onRequest(): Response {
    return Response.json({ name: this.name });
  }
}

/**
 * Regression guard: DO with `ctx.id.name === undefined` (because it was
 * addressed via `newUniqueId()`) whose `onStart()` reads `this.name`.
 * When the caller supplies the name via the `x-partykit-room` header,
 * `Server.fetch()` must apply the header BEFORE running `onStart()`, so
 * `this.name` is readable during `onStart()`.
 */
export class HeaderOnlyOnStartServer extends Server {
  onStartName: string | null = null;

  async onStart() {
    // Throws if `this.name` isn't resolvable here.
    this.onStartName = this.name;
  }

  onRequest(): Response {
    return Response.json({
      name: this.name,
      onStartName: this.onStartName
    });
  }
}

/**
 * Same scenario as `FacetLikeBootstrapServer`, but uses the sanctioned
 * `setName()` bootstrap API instead of writing `__ps_name` directly to
 * storage. Verifies that `setName()` alone is sufficient: it stashes
 * `#_name` in memory AND persists it to storage so cold-wake fetches
 * recover the name through `#ensureInitialized()`'s legacy fallback.
 */
export class SetNameBootstrapServer extends Server {
  static options = { hibernate: true };

  onStartName: string | null = null;

  async onStart() {
    try {
      this.onStartName = this.name;
    } catch {
      this.onStartName = null;
    }
  }

  async bootstrap(name: string): Promise<{ onStartName: string | null }> {
    await this.setName(name);
    return { onStartName: this.onStartName };
  }

  /**
   * Probe storage from outside the DO to verify `setName()` persisted
   * the name under the legacy `__ps_name` key.
   */
  async readStoredName(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("__ps_name");
  }

  onRequest(): Response {
    return Response.json({
      name: this.name,
      onStartName: this.onStartName
    });
  }
}

/**
 * Legacy bootstrap fixture: a DO addressed via `newUniqueId()` (so
 * `ctx.id.name` is undefined) whose framework writes `__ps_name` to
 * storage directly and then triggers `onStart()`. PartyServer must
 * pick up the legacy storage record as a fallback so `onStart()` and
 * subsequent handlers can read `this.name`.
 *
 * Note: the class name is historical — it does NOT reflect how
 * Cloudflare Agents facets actually work. Real facets (spawned via
 * `ctx.facets.get(...)`) inherit the parent DO's `ctx.id` and should
 * be created with an explicit `id` in `FacetStartupOptions` so the
 * facet has its own `ctx.id.name`. See the `facets` describe block
 * in `index.test.ts` for the recommended facet pattern.
 */
export class FacetLikeBootstrapServer extends Server {
  static options = { hibernate: true };

  onStartName: string | null = null;

  async onStart() {
    try {
      this.onStartName = this.name;
    } catch {
      this.onStartName = null;
    }
  }

  async bootstrap(name: string): Promise<{ onStartName: string | null }> {
    await this.ctx.storage.put("__ps_name", name);
    await this.__unsafe_ensureInitialized();
    return { onStartName: this.onStartName };
  }

  onRequest(): Response {
    return Response.json({
      name: this.name,
      onStartName: this.onStartName
    });
  }
}

/**
 * Regression guard for the headline Phase 1 capability: `this.name` must
 * be readable inside the constructor and from class field initializers,
 * not just after `setName()`/`fetch()` has been called.
 */
export class NameInConstructorServer extends Server {
  // Class field initializer — runs in subclass after super(), before the
  // constructor body. `this.ctx.id.name` must already be populated here.
  fieldName = this.name;

  constructorName: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.constructorName = this.name;
  }

  onRequest(): Response {
    return Response.json({
      fieldName: this.fieldName,
      constructorName: this.constructorName,
      currentName: this.name
    });
  }
}

export class Mixed extends Server {
  static options = {
    hibernate: true
  };

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/foreign")) {
      const room = request.headers.get("x-partykit-room");
      if (room) {
        await this.setName(room);
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Accept a hibernated websocket that PartyServer does not manage. This is
      // equivalent to user code calling `this.ctx.acceptWebSocket()` directly.
      this.ctx.acceptWebSocket(server, ["foreign"]);
      return new Response(null, { status: 101, webSocket: client });
    }

    return super.fetch(request);
  }

  onConnect(connection: Connection): void {
    // Trigger a broadcast while a foreign hibernated socket exists.
    this.broadcast("hello");
    connection.send("connected");
  }
}

/**
 * Tests that state and setState on a connection can be redefined via
 * Object.defineProperty (configurable: true). This simulates what the
 * Cloudflare Agents SDK does to namespace internal state keys.
 */
export class ConfigurableState extends Server {
  static options = {
    hibernate: true
  };

  onConnect(connection: Connection): void {
    // Redefine state and setState with a custom namespace,
    // similar to what the Agents SDK does.
    let _customState: unknown = { custom: true };

    Object.defineProperty(connection, "state", {
      configurable: true,
      get() {
        return _customState;
      }
    });

    Object.defineProperty(connection, "setState", {
      configurable: true,
      value(newState: unknown) {
        _customState = newState;
        return _customState;
      }
    });

    // Use the redefined setState / state to verify they work
    connection.setState({ answer: 42 });
    connection.send(JSON.stringify(connection.state));
  }
}

/**
 * Tests that setState persists state and the state getter reads it back
 * correctly through the serialization layer (hibernating path).
 */
export class StateRoundTrip extends Server {
  static options = {
    hibernate: true
  };

  onConnect(connection: Connection): void {
    connection.setState({ count: 1 });
  }

  onMessage(connection: Connection, message: string | ArrayBuffer): void {
    if (message === "get") {
      connection.send(JSON.stringify(connection.state));
    } else if (message === "increment") {
      connection.setState((prev: { count: number } | null) => ({
        count: (prev?.count ?? 0) + 1
      }));
      connection.send(JSON.stringify(connection.state));
    }
  }
}

/**
 * Same as ConfigurableState but without hibernation (non-hibernating path).
 * Verifies that the Object.assign path also allows redefinition.
 */
export class ConfigurableStateInMemory extends Server {
  // no hibernate — uses the in-memory Object.assign path
  onConnect(connection: Connection): void {
    let _customState: unknown = { custom: true };

    Object.defineProperty(connection, "state", {
      configurable: true,
      get() {
        return _customState;
      },
      set(v: unknown) {
        _customState = v;
      }
    });

    Object.defineProperty(connection, "setState", {
      configurable: true,
      value(newState: unknown) {
        _customState = newState;
        return _customState;
      }
    });

    connection.setState({ answer: 99 });
    connection.send(JSON.stringify(connection.state));
  }
}

/**
 * Tests that onStart failure resets the status so subsequent requests
 * can retry initialization. The first call to onStart throws; the second
 * succeeds.
 */
export class FailingOnStartServer extends Server {
  counter = 0;
  failCount = 0;

  async onStart() {
    this.counter++;
    if (this.counter === 1) {
      this.failCount++;
      throw new Error("onStart failed on first attempt");
    }
  }

  onRequest(): Response {
    return Response.json({
      counter: this.counter,
      failCount: this.failCount
    });
  }
}

/**
 * Tests that this.name is correctly available in onMessage after a
 * hibernating server wakes up. Sends this.name back in onMessage.
 */
export class HibernatingNameInMessage extends Server {
  static options = {
    hibernate: true
  };

  onConnect(connection: Connection): void {
    connection.send(`connected:${this.name}:${connection.server}`);
  }

  onMessage(connection: Connection, _message: WSMessage): void {
    connection.send(`name:${this.name}:${connection.server}`);
  }
}

/**
 * Tests that connection.tags is readable in hibernating mode.
 */
export class TagsServer extends Server {
  static options = {
    hibernate: true
  };

  getConnectionTags(
    _connection: Connection,
    _ctx: ConnectionContext
  ): string[] {
    return ["role:admin", "room:lobby"];
  }

  onConnect(connection: Connection): void {
    connection.send(JSON.stringify(connection.tags));
  }

  onMessage(connection: Connection, _message: WSMessage): void {
    // Also verify tags survive hibernation wake-up
    connection.send(JSON.stringify(connection.tags));
  }
}

/**
 * Tests that connection.tags is readable in non-hibernating (in-memory) mode.
 */
export class TagsServerInMemory extends Server {
  // no hibernate — uses the in-memory path

  getConnectionTags(
    _connection: Connection,
    _ctx: ConnectionContext
  ): string[] {
    return ["role:viewer", "room:general"];
  }

  onConnect(connection: Connection): void {
    connection.send(JSON.stringify(connection.tags));
  }
}

/**
 * Tests that connection.uri is available in hibernating mode (onConnect + onMessage).
 */
export class UriServer extends Server {
  static options = {
    hibernate: true
  };

  onConnect(connection: Connection): void {
    connection.send(JSON.stringify({ uri: connection.uri }));
  }

  onMessage(connection: Connection, _message: WSMessage): void {
    connection.send(JSON.stringify({ uri: connection.uri }));
  }
}

/**
 * Tests that connection.uri is available in non-hibernating (in-memory) mode.
 */
export class UriServerInMemory extends Server {
  onConnect(connection: Connection): void {
    connection.send(JSON.stringify({ uri: connection.uri }));
  }

  onMessage(connection: Connection, _message: WSMessage): void {
    connection.send(JSON.stringify({ uri: connection.uri }));
  }
}

export class PropsServer extends Server<Env, { secret: string }> {
  receivedProps: { secret: string } | undefined;

  onStart(props?: { secret: string }) {
    this.receivedProps = props;
  }

  onRequest(request: Request): Response {
    return Response.json({
      name: this.name,
      props: this.receivedProps,
      // Echo the raw header so tests can verify it is ASCII-safe.
      rawPropsHeader: request.headers.get("x-partykit-props")
    });
  }

  onConnect(connection: Connection): void {
    connection.send(
      JSON.stringify({ name: this.name, props: this.receivedProps })
    );
  }
}

export class CorsServer extends Server {
  onRequest(): Response | Promise<Response> {
    return Response.json({ cors: true });
  }
}

export class CustomCorsServer extends Server {
  onRequest(): Response | Promise<Response> {
    return Response.json({ customCors: true });
  }
}

/**
 * Sub-DO spawned as a facet from `FacetParent` via `ctx.facets.get()`.
 *
 * The facet exposes a few RPC probes the test uses to inspect its
 * own identity from inside (since `ctx.id.name` etc. depend on how
 * `FacetStartupOptions.id` was supplied at the parent's
 * `ctx.facets.get(...)` call).
 *
 * `getName()` calls `__unsafe_ensureInitialized()` first so the test
 * exercises the realistic cold-wake path (native DO RPCs don't pass
 * through `Server.fetch`, so `#ensureInitialized()` would otherwise
 * not run). This mirrors what frameworks like Cloudflare Agents do
 * inside their RPC bridges.
 */
export class FacetChild extends Server {
  static options = { hibernate: true };

  onStartName: string | null = null;

  async onStart() {
    try {
      this.onStartName = this.name;
    } catch {
      this.onStartName = null;
    }
  }

  async getName(): Promise<string> {
    await this.__unsafe_ensureInitialized();
    return this.name;
  }

  async getCtxIdName(): Promise<string | undefined> {
    return this.ctx.id.name;
  }

  async getStoredName(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("__ps_name");
  }

  async getOnStartName(): Promise<string | null> {
    await this.__unsafe_ensureInitialized();
    return this.onStartName;
  }

  /**
   * Convenience: snapshot all four name-related sources in one
   * round trip. Tries `getName()` first, but tolerates it throwing
   * (which it will when `ctx.id.name` is undefined and no `setName`
   * override has run) and reports `null` instead.
   */
  async snapshot(): Promise<{
    name: string | null;
    ctxIdName: string | undefined;
    storedName: string | undefined;
    onStartName: string | null;
  }> {
    let name: string | null = null;
    try {
      name = await this.getName();
    } catch {
      name = null;
    }
    return {
      name,
      ctxIdName: this.ctx.id.name,
      storedName: await this.ctx.storage.get<string>("__ps_name"),
      onStartName: this.onStartName
    };
  }
}

/**
 * Parent DO that spawns a `FacetChild` via the workerd facet API.
 */
export class FacetParent extends Server {
  /**
   * Spawn a facet WITHOUT an explicit `id`. Per the Cloudflare facet
   * docs, this causes the facet to inherit the parent's `ctx.id`
   * (including `ctx.id.name`). Used by the test to document this
   * runtime contract — it's not a recommended pattern.
   */
  async spawnImplicitId(facetName: string): Promise<{
    parentName: string;
    facet: {
      name: string | null;
      ctxIdName: string | undefined;
      storedName: string | undefined;
      onStartName: string | null;
    };
  }> {
    const Cls = (this.ctx.exports as Record<string, unknown>)
      .FacetChild as DurableObjectClass<FacetChild>;
    const stub = this.ctx.facets.get(facetName, () => ({
      class: Cls
    })) as unknown as DurableObjectStub<FacetChild>;
    return { parentName: this.name, facet: await stub.snapshot() };
  }

  /**
   * Spawn a facet WITH an explicit `id` constructed three different
   * ways, so the test can confirm which work. The recommended
   * pattern for frameworks is the `ctx-exports-namespace` form:
   * `ctx.exports[BoundClassName].idFromName(facetName)`. It works
   * without needing to know an env binding name, and produces a
   * facet whose `ctx.id.name` is the facet's own name.
   */
  async spawnWithExplicitId(
    facetName: string,
    idSource: "env-namespace" | "ctx-exports-namespace" | "plain-string"
  ): Promise<{
    parentName: string;
    facet: {
      name: string | null;
      ctxIdName: string | undefined;
      storedName: string | undefined;
      onStartName: string | null;
    };
  }> {
    const Cls = (this.ctx.exports as Record<string, unknown>)
      .FacetChild as DurableObjectClass<FacetChild>;
    let id: DurableObjectId | string;
    if (idSource === "env-namespace") {
      id = (this.env as Env).FacetParent.idFromName(facetName);
    } else if (idSource === "ctx-exports-namespace") {
      const ns = (this.ctx.exports as Record<string, unknown>)
        .FacetParent as DurableObjectNamespace<FacetParent>;
      id = ns.idFromName(facetName);
    } else {
      id = facetName;
    }
    const stub = this.ctx.facets.get(facetName, () => ({
      class: Cls,
      id
    })) as unknown as DurableObjectStub<FacetChild>;
    return { parentName: this.name, facet: await stub.snapshot() };
  }
}

/**
 * Raw `DurableObject` fixture (no PartyServer wrapping) used to probe
 * the underlying runtime contract for `ctx.id.name`. Schedules an alarm
 * during `fetch()` and records the value of `ctx.id.name` observed in
 * both `fetch()` and `alarm()`. The test runtime uses this repository's
 * standard `2026-06-11` compatibility date.
 */
export class RawAlarmDO extends DurableObject {
  fetchCtxIdName: string | undefined;
  alarmCtxIdName: string | undefined | null = null;

  async fetch(_request: Request): Promise<Response> {
    this.fetchCtxIdName = this.ctx.id.name;
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    return Response.json({
      fetchCtxIdName: this.fetchCtxIdName,
      alarmCtxIdName: this.alarmCtxIdName
    });
  }

  async alarm(): Promise<void> {
    this.alarmCtxIdName = this.ctx.id.name;
  }

  async snapshot(): Promise<{
    fetchCtxIdName: string | undefined;
    alarmCtxIdName: string | undefined | null;
  }> {
    return {
      fetchCtxIdName: this.fetchCtxIdName,
      alarmCtxIdName: this.alarmCtxIdName
    };
  }
}

/**
 * Records every `onClose` invocation, plus the `readyState` of the
 * connection at the moment `onClose` fires. Used by the close-handshake
 * tests to verify both that `onClose` is called with the right args AND
 * that the framework reciprocates the Close frame so the client-side
 * socket transitions to CLOSED cleanly.
 *
 * The `lastClose` snapshot is read back via an HTTP request rather than
 * a follow-up WebSocket, because hibernation evicts in-memory state and
 * we want to verify the recorded close survives a wake-up cycle.
 */
type CloseRecord = {
  code: number;
  reason: string;
  wasClean: boolean;
  /** ws.readyState at the start of onClose, before any reciprocation. */
  readyStateAtOnClose: number;
  id: string;
};

export class CloseHandshakeHibernating extends Server {
  static options = { hibernate: true };

  override onConnect(connection: Connection): void {
    connection.send("hello");
  }

  override async onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    const record: CloseRecord = {
      code,
      reason,
      wasClean,
      readyStateAtOnClose: connection.readyState,
      id: connection.id
    };
    await this.ctx.storage.put<CloseRecord>("lastClose", record);
  }

  override onRequest = async (): Promise<Response> => {
    const record = await this.ctx.storage.get<CloseRecord>("lastClose");
    return Response.json({ lastClose: record ?? null });
  };
}

export class CloseHandshakeInMemory extends Server {
  // No hibernation — exercises #attachSocketEventHandlers.

  lastClose: CloseRecord | null = null;

  override onConnect(connection: Connection): void {
    connection.send("hello");
  }

  override onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): void {
    this.lastClose = {
      code,
      reason,
      wasClean,
      readyStateAtOnClose: connection.readyState,
      id: connection.id
    };
  }

  override onRequest = async (): Promise<Response> => {
    return Response.json({ lastClose: this.lastClose });
  };
}

/**
 * `onClose` throws. The framework must still reciprocate the close so
 * the client never sees a 1006 abnormal closure. Mirrors the behavior
 * users get from buggy `onClose` overrides.
 */
export class ThrowingCloseHibernating extends Server {
  static options = { hibernate: true };

  override onConnect(connection: Connection): void {
    connection.send("hello");
  }

  override onClose(): void {
    throw new Error("intentional onClose failure (hibernating)");
  }
}

export class ThrowingCloseInMemory extends Server {
  override onConnect(connection: Connection): void {
    connection.send("hello");
  }

  override onClose(): void {
    throw new Error("intentional onClose failure (in-memory)");
  }
}

/**
 * User code itself calls `connection.close(...)` from inside `onClose`
 * with an arbitrary code. The framework's reciprocation in `finally`
 * must be a no-op (idempotent), and the client must observe the code
 * the *peer* sent, not the one user code passed. This is the contract
 * for "the server reflects the client's close".
 */
export class UserClosesInOnCloseHibernating extends Server {
  static options = { hibernate: true };

  override onConnect(connection: Connection): void {
    connection.send("hello");
  }

  override onClose(connection: Connection): void {
    connection.close(4000, "user-initiated-from-onclose");
  }
}

export class UserClosesInOnCloseInMemory extends Server {
  override onConnect(connection: Connection): void {
    connection.send("hello");
  }

  override onClose(connection: Connection): void {
    connection.close(4000, "user-initiated-from-onclose");
  }
}

type LifecycleProbeProps = { label: string };

export class LifecycleProbe extends Server<Env, LifecycleProbeProps> {
  readonly #calls: string[] = [];

  readonly #first: DurableObjectLifecycleComponent<LifecycleProbeProps> = {
    onStart: ({ props }) => {
      this.#calls.push(`first:start:${props?.label ?? "none"}`);
    },
    onRequest: () => {
      this.#calls.push("first:request");
    },
    onAlarm: () => {
      this.#calls.push("first:alarm");
    },
    onDispose: () => {
      this.#calls.push("first:dispose");
    }
  };

  readonly #second: DurableObjectLifecycleComponent<LifecycleProbeProps> = {
    onStart: () => {
      this.#calls.push("second:start");
    },
    onRequest: ({ request }) => {
      this.#calls.push("second:request");
      if (new URL(request.url).searchParams.has("intercept")) {
        return Response.json(this.#calls);
      }
    },
    onAlarm: () => {
      this.#calls.push("second:alarm");
    },
    onDispose: () => {
      this.#calls.push("second:dispose");
    }
  };

  protected override get lifecycleComponents(): ReadonlyArray<
    DurableObjectLifecycleComponent<LifecycleProbeProps>
  > {
    return [this.#first, this.#second];
  }

  override onStart(): void {
    this.#calls.push("user:start");
  }

  override onRequest(): Response {
    this.#calls.push("user:request");
    return Response.json(this.#calls);
  }

  override onAlarm(): void {
    this.#calls.push("user:alarm");
  }

  async scheduleAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  getCalls(): ReadonlyArray<string> {
    return this.#calls;
  }

  async disposeForTest(): Promise<ReadonlyArray<string>> {
    await this.disposeLifecycle();
    return this.#calls;
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/lifecycle-parties/")) {
      return (
        (await routePartykitRequest(request, env, {
          prefix: "lifecycle-parties",
          props: { label: "routed" }
        })) || new Response("Not Found", { status: 404 })
      );
    }

    // Route requests under /props-parties/ with props
    if (url.pathname.startsWith("/props-parties/")) {
      return (
        (await routePartykitRequest(request, env, {
          prefix: "props-parties",
          props: { secret: "my-secret-value" }
        })) || new Response("Not Found", { status: 404 })
      );
    }

    // Route requests under /unicode-props-parties/ with non-ASCII props.
    // Regression coverage for cloudflare/agents#1751: header values must be
    // ASCII-safe so workerd doesn't warn (and browsers don't throw).
    if (url.pathname.startsWith("/unicode-props-parties/")) {
      return (
        (await routePartykitRequest(request, env, {
          prefix: "unicode-props-parties",
          props: { secret: "Usuário 日本語 🎉" }
        })) || new Response("Not Found", { status: 404 })
      );
    }

    // Route requests under /cors-parties/ with cors: true
    if (url.pathname.startsWith("/cors-parties/")) {
      return (
        (await routePartykitRequest(request, env, {
          prefix: "cors-parties",
          cors: true,
          onBeforeRequest: async (_req, { name }) => {
            if (name === "blocked") {
              return new Response("Forbidden", { status: 403 });
            }
          }
        })) || new Response("Not Found", { status: 404 })
      );
    }

    // Route requests under /custom-cors-parties/ with custom CORS headers
    if (url.pathname.startsWith("/custom-cors-parties/")) {
      return (
        (await routePartykitRequest(request, env, {
          prefix: "custom-cors-parties",
          cors: {
            "Access-Control-Allow-Origin": "https://example.com",
            "Access-Control-Allow-Methods": "GET, POST"
          }
        })) || new Response("Not Found", { status: 404 })
      );
    }

    return (
      (await routePartykitRequest(request, env, {
        onBeforeConnect: async (_request, { className, name }) => {
          if (className === "OnStartServer") {
            if (name === "is-error") {
              return new Response("Error", { status: 503 });
            } else if (name === "is-redirect") {
              return new Response("Redirect", {
                status: 302,
                headers: { Location: "https://example2.com" }
              });
            }
          }
        },
        onBeforeRequest: async (_request, lobby) => {
          if (lobby.className === "OnStartServer") {
            if (lobby.name === "is-error") {
              return new Response("Error", { status: 504 });
            } else if (lobby.name === "is-redirect") {
              return new Response("Redirect", {
                status: 302,
                headers: { Location: "https://example3.com" }
              });
            }
          }
          if (lobby.name === "lobby-info") {
            return Response.json({
              className: lobby.className,
              name: lobby.name
            });
          }
        }
      })) || new Response("Not Found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
