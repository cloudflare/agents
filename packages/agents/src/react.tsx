import type { PartySocket } from "partysocket";
import { usePartySocket } from "partysocket/react";
import { useCallback, useRef, use, useMemo, useState, useEffect } from "react";
import type { MCPServersState, RPCRequest, RPCResponse } from "./";
import type {
  AgentPromiseReturnType,
  AgentStub,
  CallOptions,
  OptionalAgentMethods,
  RequiredAgentMethods,
  StreamOptions,
  UntypedAgentStub
} from "./client";
import type { ClientParameters } from "./serializable";
import { createStubProxy, DEFAULT_CALL_TIMEOUT_MS } from "./client";
import { camelCaseToKebabCase } from "./utils";
import { MessageType } from "./types";
import {
  applyAgentToolEvent,
  createAgentToolEventState,
  type AgentToolEventMessage,
  type AgentToolEventState,
  type AgentToolRunState
} from "./chat/agent-tools";

type QueryObject = Record<string, string | null>;

interface CacheEntry {
  promise: Promise<QueryObject>;
  expiresAt: number;
}

const queryCache = new Map<string, CacheEntry>();

function createCacheKey(
  agentNamespace: string,
  name: string | undefined,
  subChainOrDeps: ReadonlyArray<{ agent: string; name: string }> | unknown[],
  deps?: unknown[]
): string {
  // Backwards-compatible overload: if called with 3 args, the third
  // argument is `deps` and `subChain` defaults to empty. With 4 args,
  // the third is the sub-chain. This keeps existing callers (and
  // the `_testUtils` surface) working while letting new callers
  // include the nested chain in the cache key.
  //
  // Empty sub-chain must produce the same key as the old 3-arg
  // form, so nested-addressing code can opt-in without invalidating
  // existing caches.
  if (deps === undefined) {
    return JSON.stringify([
      agentNamespace,
      name || "default",
      ...(subChainOrDeps as unknown[])
    ]);
  }
  const subChain = subChainOrDeps as ReadonlyArray<{
    agent: string;
    name: string;
  }>;
  if (subChain.length === 0) {
    return JSON.stringify([agentNamespace, name || "default", ...deps]);
  }
  return JSON.stringify([
    agentNamespace,
    name || "default",
    subChain.map((s) => [s.agent, s.name]),
    ...deps
  ]);
}

/** Build a URL path tail `/sub/{agent-kebab}/{name}/...` from a sub chain. */
function buildSubPath(
  subChain: ReadonlyArray<{ agent: string; name: string }>,
  extraPath?: string
): string {
  if (subChain.length === 0) return extraPath ?? "";
  const parts = subChain.flatMap((step) => [
    "sub",
    camelCaseToKebabCase(step.agent),
    encodeURIComponent(step.name)
  ]);
  const combined = parts.join("/");
  if (extraPath) {
    const trimmed = extraPath.startsWith("/") ? extraPath.slice(1) : extraPath;
    return `${combined}/${trimmed}`;
  }
  return combined;
}

function getCacheEntry(key: string): CacheEntry | undefined {
  const entry = queryCache.get(key);
  if (!entry) return undefined;

  if (Date.now() >= entry.expiresAt) {
    queryCache.delete(key);
    return undefined;
  }

  return entry;
}

function setCacheEntry(
  key: string,
  promise: Promise<QueryObject>,
  cacheTtl: number
): CacheEntry {
  const entry: CacheEntry = {
    promise,
    expiresAt: Date.now() + cacheTtl
  };
  queryCache.set(key, entry);
  return entry;
}

function deleteCacheEntry(key: string): void {
  queryCache.delete(key);
}

// Export for testing purposes
export const _testUtils = {
  queryCache,
  setCacheEntry,
  getCacheEntry,
  deleteCacheEntry,
  clearCache: () => queryCache.clear(),
  createStubProxy,
  createCacheKey
};

/**
 * Options for the useAgent hook
 * @template State Type of the Agent's state
 */
export type UseAgentOptions<State = unknown> = Omit<
  Parameters<typeof usePartySocket>[0],
  "party" | "room" | "query"
> & {
  /** Name of the agent to connect to (ignored if basePath is set) */
  agent: string;
  /** Name of the specific Agent instance (ignored if basePath is set) */
  name?: string;
  /**
   * Full URL path - bypasses agent/name URL construction.
   * When set, the client connects to this path directly.
   * Server must handle routing manually (e.g., with getAgentByName + fetch).
   * @example
   * // Client connects to /user, server routes based on session
   * useAgent({ agent: "UserAgent", basePath: "user" })
   */
  basePath?: string;
  /** Query parameters - can be static object or async function */
  query?: QueryObject | (() => Promise<QueryObject>);
  /** Dependencies for async query caching */
  queryDeps?: unknown[];
  /** Cache TTL in milliseconds for auth tokens/time-sensitive data */
  cacheTtl?: number;
  /** Called when the Agent's state is updated */
  onStateUpdate?: (state: State, source: "server" | "client") => void;
  /** Called when a state update fails (e.g., connection is readonly) */
  onStateUpdateError?: (error: string) => void;
  /** Called when MCP server state is updated */
  onMcpUpdate?: (mcpServers: MCPServersState) => void;
  /**
   * Called when the server sends the agent's identity on connect.
   * Useful when using basePath, as the actual instance name is determined server-side.
   * @param name The actual agent instance name
   * @param agent The agent class name (kebab-case)
   */
  onIdentity?: (name: string, agent: string) => void;
  /**
   * Called when identity changes on reconnect (different instance than before).
   * If not provided and identity changes, a warning will be logged.
   * @param oldName Previous instance name
   * @param newName New instance name
   * @param oldAgent Previous agent class name
   * @param newAgent New agent class name
   */
  onIdentityChange?: (
    oldName: string,
    newName: string,
    oldAgent: string,
    newAgent: string
  ) => void;
  /**
   * Additional path to append to the URL.
   * Works with both standard routing and basePath.
   * @example
   * // With basePath: /user/settings
   * { basePath: "user", path: "settings" }
   * // Standard: /agents/my-agent/room/settings
   * { agent: "MyAgent", name: "room", path: "settings" }
   */
  path?: string;
  /**
   * Connect to a sub-agent (facet) via its parent. Flat array,
   * root-first. Each step addresses one parent↔child hop.
   *
   * The hook's returned `.agent` / `.name` report the **leaf**
   * identity (the deepest entry in `sub`), so downstream hooks
   * like `useAgentChat` see the child they actually talk to.
   * `.path` exposes the full chain for observability, deep links,
   * and reconnect keying.
   *
   * @example
   * ```ts
   * // Two-level nesting: Inbox (Alice) → Chat (abc)
   * useAgent({
   *   agent: "inbox", name: userId,
   *   sub: [{ agent: "chat", name: chatId }]
   * });
   *
   * // Three-level: tenant → inbox → chat
   * useAgent({
   *   agent: "tenant", name: tenantId,
   *   sub: [
   *     { agent: "inbox", name: userId },
   *     { agent: "chat",  name: chatId }
   *   ]
   * });
   * ```
   *
   * @experimental The API surface may change before stabilizing.
   */
  sub?: ReadonlyArray<{ agent: string; name: string }>;
  /**
   * Default timeout (in milliseconds) applied to non-streaming `call()`s
   * that don't pass an explicit `timeout`. Acts as a backstop so calls
   * whose response is lost (e.g. the connection is replaced mid-flight)
   * reject instead of hanging forever.
   *
   * Defaults to 30 000 ms. Set to `0` to disable the default timeout.
   * Streaming calls never get a default timeout (long-lived streams are
   * legitimate); pass an explicit `timeout` to bound them.
   */
  defaultCallTimeout?: number;
};

type OptionalArgsAgentMethodCall<AgentT> = <
  K extends keyof OptionalAgentMethods<AgentT>
>(
  method: K,
  args?: ClientParameters<OptionalAgentMethods<AgentT>[K]>,
  options?: CallOptions | StreamOptions
) => AgentPromiseReturnType<AgentT, K>;

type RequiredArgsAgentMethodCall<AgentT> = <
  K extends keyof RequiredAgentMethods<AgentT>
>(
  method: K,
  args: ClientParameters<RequiredAgentMethods<AgentT>[K]>,
  options?: CallOptions | StreamOptions
) => AgentPromiseReturnType<AgentT, K>;

type AgentMethodCall<AgentT> = OptionalArgsAgentMethodCall<AgentT> &
  RequiredArgsAgentMethodCall<AgentT>;

type UntypedAgentMethodCall = <T = unknown>(
  method: string,
  args?: unknown[],
  options?: CallOptions | StreamOptions
) => Promise<T>;

/**
 * React hook for connecting to an Agent
 */
export function useAgent<State = unknown>(
  options: UseAgentOptions<State>
): Omit<PartySocket, "path"> & {
  agent: string;
  name: string;
  /** Full root-first address chain, including leaf. Single entry when `sub` isn't set. */
  path: ReadonlyArray<{ agent: string; name: string }>;
  identified: boolean;
  ready: Promise<void>;
  state: State | undefined;
  setState: (state: State) => void;
  call: UntypedAgentMethodCall;
  stub: UntypedAgentStub;
  getHttpUrl: () => string;
};
export function useAgent<
  AgentT extends {
    get state(): State;
  },
  State
>(
  options: UseAgentOptions<State>
): Omit<PartySocket, "path"> & {
  agent: string;
  name: string;
  path: ReadonlyArray<{ agent: string; name: string }>;
  identified: boolean;
  ready: Promise<void>;
  state: State | undefined;
  setState: (state: State) => void;
  call: AgentMethodCall<AgentT>;
  stub: AgentStub<AgentT>;
  getHttpUrl: () => string;
};
export function useAgent<State>(options: UseAgentOptions<unknown>): Omit<
  PartySocket,
  "path"
> & {
  agent: string;
  name: string;
  path: ReadonlyArray<{ agent: string; name: string }>;
  identified: boolean;
  ready: Promise<void>;
  state: State | undefined;
  setState: (state: State) => void;
  call: UntypedAgentMethodCall | AgentMethodCall<unknown>;
  stub: UntypedAgentStub;
  getHttpUrl: () => string;
} {
  const agentNamespace = camelCaseToKebabCase(options.agent);
  // NOTE: `path` is destructured out (as `userPath`) so it does NOT
  // end up in `restOptions`. Spreading `restOptions` after the
  // computed `path: combinedPath` would otherwise let the user's raw
  // `path` overwrite the combined sub-agent URL, dropping every
  // `/sub/{child}/{name}` segment on the way to the socket.
  const {
    query,
    queryDeps,
    cacheTtl,
    sub: subOption,
    path: userPath,
    defaultCallTimeout,
    ...restOptions
  } = options;

  const subChain = useMemo(
    () => (subOption ?? []).map((s) => ({ agent: s.agent, name: s.name })),
    // Stable serialization — deep changes re-memoize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(subOption ?? [])]
  );

  // The "leaf" is the deepest entry in the chain; it's what
  // downstream code (useAgentChat etc.) should see as the
  // authoritative identity.
  const leafAgent =
    subChain.length > 0 ? subChain[subChain.length - 1].agent : options.agent;
  const leafName =
    subChain.length > 0
      ? subChain[subChain.length - 1].name
      : options.name || "default";

  // Full root-first chain, including the leaf. Exposed as `.path`
  // and used for cache keying so nested sessions with the same leaf
  // name don't collide.
  const fullPath = useMemo(
    () => [
      { agent: options.agent, name: options.name || "default" },
      ...subChain
    ],
    [options.agent, options.name, subChain]
  );

  // Keep track of pending RPC calls.
  //
  // Each entry is tagged with the socket the request was transmitted on
  // (`sentOn`). Requests are only handed to a socket once it's OPEN —
  // until then they stay queued here (`sentOn: null`). This matters
  // because `usePartySocket` *replaces* the socket object whenever
  // connection options change (async query refresh, path change, etc.):
  // anything buffered inside a replaced socket is lost forever, and a
  // call transmitted on a replaced socket can never receive its
  // response. Tagging lets us:
  // - flush still-queued requests on whichever socket connects next
  //   (safe: they were never transmitted, so no double-execution risk)
  // - reject calls transmitted on a socket that closed or was replaced
  //   (their response can never arrive)
  // - avoid rejecting calls in flight on the *new* socket when a stale
  //   close event from an old socket trickles in
  const pendingCallsRef = useRef(
    new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        stream?: StreamOptions;
        timeoutId?: ReturnType<typeof setTimeout>;
        /** Serialized RPC request, kept so it can be (re)transmitted */
        request: string;
        /** Socket the request was transmitted on; null while queued */
        sentOn: PartySocket | null;
      }
    >()
  );

  // Always points at the socket from the latest render. `call`,
  // `setState`, and the queue-flushing logic go through this ref so
  // that stale `agent` references held by old effect closures still
  // route their traffic to the live socket instead of a dead one.
  const socketRef = useRef<PartySocket | null>(null);

  const defaultCallTimeoutRef = useRef(
    defaultCallTimeout ?? DEFAULT_CALL_TIMEOUT_MS
  );
  defaultCallTimeoutRef.current = defaultCallTimeout ?? DEFAULT_CALL_TIMEOUT_MS;

  /** Reject (and remove) every pending call transmitted on `socket`. */
  const rejectCallsSentOn = (socket: PartySocket, reason: string) => {
    const error = new Error(reason);
    for (const [id, pending] of pendingCallsRef.current) {
      if (pending.sentOn === socket) {
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        pendingCallsRef.current.delete(id);
        pending.reject(error);
        pending.stream?.onError?.(reason);
      }
    }
  };

  /** Transmit queued (never-sent) calls if the live socket is open. */
  const flushQueuedCalls = () => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== socket.OPEN) return;
    for (const pending of pendingCallsRef.current.values()) {
      if (pending.sentOn === null) {
        socket.send(pending.request);
        pending.sentOn = socket;
      }
    }
  };

  /** Reject (and remove) every still-queued (never transmitted) call. */
  const rejectQueuedCalls = (reason: string) => {
    const error = new Error(reason);
    for (const [id, pending] of pendingCallsRef.current) {
      if (pending.sentOn === null) {
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        pendingCallsRef.current.delete(id);
        pending.reject(error);
        pending.stream?.onError?.(reason);
      }
    }
  };

  const cacheKey = useMemo(
    () =>
      createCacheKey(agentNamespace, options.name, subChain, queryDeps || []),
    [agentNamespace, options.name, subChain, queryDeps]
  );

  // Track current cache key in a ref for use in onClose handler.
  // This ensures we invalidate the correct cache entry when the connection closes,
  // even if the component re-renders with different props before onClose fires.
  // We update synchronously during render (not in useEffect) to avoid race
  // conditions where onClose could fire before the effect runs.
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;

  const ttl = cacheTtl ?? 5 * 60 * 1000;

  // Track cache invalidation to force re-render when TTL expires
  const [cacheInvalidatedAt, setCacheInvalidatedAt] = useState<number>(0);

  // Disable socket while waiting for async query to refresh after disconnect
  const isAsyncQuery = query && typeof query === "function";
  const [awaitingQueryRefresh, setAwaitingQueryRefresh] = useState(false);

  // Get or create the query promise
  const queryPromise = useMemo(() => {
    // Re-run when cache is invalidated after TTL expiry
    void cacheInvalidatedAt;

    if (!query || typeof query !== "function") {
      return null;
    }

    // Always check cache first to deduplicate concurrent requests
    const cached = getCacheEntry(cacheKey);
    if (cached) {
      return cached.promise;
    }

    // Create new promise
    const promise = query().catch((error) => {
      console.error(
        `[useAgent] Query failed for agent "${options.agent}":`,
        error
      );
      deleteCacheEntry(cacheKey);
      throw error;
    });

    // Always cache to deduplicate concurrent requests
    setCacheEntry(cacheKey, promise, ttl);

    return promise;
  }, [cacheKey, query, options.agent, ttl, cacheInvalidatedAt]);

  // Schedule cache invalidation when TTL expires
  useEffect(() => {
    if (!queryPromise || ttl <= 0) return;

    const entry = getCacheEntry(cacheKey);
    if (!entry) return;

    const timeUntilExpiry = entry.expiresAt - Date.now();

    // Always set a timer (with min 0ms) to ensure cleanup function is returned
    const timer = setTimeout(
      () => {
        deleteCacheEntry(cacheKey);
        setCacheInvalidatedAt(Date.now());
      },
      Math.max(0, timeUntilExpiry)
    );

    return () => clearTimeout(timer);
  }, [cacheKey, queryPromise, ttl]);

  let resolvedQuery: QueryObject | undefined;

  if (query) {
    if (typeof query === "function") {
      // Use React's use() to resolve the promise
      const queryResult = use(queryPromise!);

      // Check for non-primitive values and warn
      if (queryResult) {
        for (const [key, value] of Object.entries(queryResult)) {
          if (
            value !== null &&
            value !== undefined &&
            typeof value !== "string" &&
            typeof value !== "number" &&
            typeof value !== "boolean"
          ) {
            console.warn(
              `[useAgent] Query parameter "${key}" is an object and will be converted to "[object Object]". ` +
                "Query parameters should be string, number, boolean, or null."
            );
          }
        }
        resolvedQuery = queryResult;
      }
    } else {
      // Sync query - use directly
      resolvedQuery = query;
    }
  }

  // Re-enable socket after async query resolves
  useEffect(() => {
    if (awaitingQueryRefresh && resolvedQuery !== undefined) {
      setAwaitingQueryRefresh(false);
    }
  }, [awaitingQueryRefresh, resolvedQuery]);

  // Track agent state for reactivity — updated on server broadcasts and client setState
  const [agentState, setAgentState] = useState<State | undefined>(undefined);

  // Store identity in React state for reactivity. Seed with the
  // leaf's address — what the server will echo back in
  // `cf_agent_identity`.
  const [identity, setIdentity] = useState({
    name: leafName,
    agent: camelCaseToKebabCase(leafAgent),
    identified: false
  });

  // Track previous identity for change detection
  const previousIdentityRef = useRef<{
    name: string | null;
    agent: string | null;
  }>({ name: null, agent: null });

  // Ready promise - resolves when identity is received, resets on close
  const readyRef = useRef<
    { promise: Promise<void>; resolve: () => void } | undefined
  >(undefined);

  const resetReady = () => {
    let resolve: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    readyRef.current = { promise, resolve: resolve! };
  };

  if (!readyRef.current) {
    resetReady();
  }

  const mutableAgentRef = useRef<{
    agent: string;
    name: string;
    identified: boolean;
  } | null>(null);

  // Combine the sub-agent chain with the user-provided `path`.
  // Order matters: `/sub/{child}/{name}/...` comes before `path` so
  // the server sees the hierarchy it expects.
  const combinedPath = useMemo(
    () => buildSubPath(subChain, userPath),
    [subChain, userPath]
  );

  // If basePath is provided, use it directly; otherwise construct from agent/name
  const socketOptions = options.basePath
    ? {
        basePath: options.basePath,
        path: combinedPath || undefined,
        query: resolvedQuery,
        ...restOptions
      }
    : {
        party: agentNamespace,
        prefix: "agents",
        room: options.name || "default",
        path: combinedPath || undefined,
        query: resolvedQuery,
        ...restOptions
      };

  const socketEnabled = !awaitingQueryRefresh && (restOptions.enabled ?? true);

  // Identifies *which agent instance* this hook is addressing. Queued
  // (never-transmitted) RPC calls are only safe to flush onto a later
  // socket if it still points at the same instance — a call composed for
  // agent "alpha" must not execute on agent "beta" just because the
  // `name` prop changed while the call was waiting for a connection.
  // Credentials (query params) are deliberately excluded: a token
  // refresh doesn't change where calls go.
  const addressKey = JSON.stringify([
    options.host ?? null,
    options.basePath ?? null,
    agentNamespace,
    options.name || "default",
    combinedPath || null
  ]);

  const agent = usePartySocket({
    ...socketOptions,
    enabled: socketEnabled,
    onOpen: (event: Event) => {
      // The socket is open: transmit any RPC requests that were issued
      // while disconnected (or while a previous socket was being
      // replaced). They were never handed to a socket before, so this
      // cannot double-execute anything server-side.
      flushQueuedCalls();
      options.onOpen?.(event);
    },
    onMessage: (message) => {
      if (typeof message.data === "string") {
        let parsedMessage: Record<string, unknown>;
        try {
          parsedMessage = JSON.parse(message.data);
        } catch (_error) {
          // silently ignore invalid messages for now
          // TODO: log errors with log levels
          return options.onMessage?.(message);
        }
        if (parsedMessage.type === MessageType.CF_AGENT_IDENTITY) {
          const oldName = previousIdentityRef.current.name;
          const oldAgent = previousIdentityRef.current.agent;
          const newName = parsedMessage.name as string;
          const newAgent = parsedMessage.agent as string;

          const currentAgent = mutableAgentRef.current;
          if (currentAgent) {
            currentAgent.name = newName;
            currentAgent.agent = newAgent;
            currentAgent.identified = true;
          }

          // Update reactive state (triggers re-render)
          setIdentity({ name: newName, agent: newAgent, identified: true });

          // Resolve ready promise
          readyRef.current?.resolve();

          // Detect identity change on reconnect
          if (
            oldName !== null &&
            oldAgent !== null &&
            (oldName !== newName || oldAgent !== newAgent)
          ) {
            if (options.onIdentityChange) {
              options.onIdentityChange(oldName, newName, oldAgent, newAgent);
            } else {
              const agentChanged = oldAgent !== newAgent;
              const nameChanged = oldName !== newName;
              let changeDescription = "";
              if (agentChanged && nameChanged) {
                changeDescription = `agent "${oldAgent}" → "${newAgent}", instance "${oldName}" → "${newName}"`;
              } else if (agentChanged) {
                changeDescription = `agent "${oldAgent}" → "${newAgent}"`;
              } else {
                changeDescription = `instance "${oldName}" → "${newName}"`;
              }
              console.warn(
                `[agents] Identity changed on reconnect: ${changeDescription}. ` +
                  "This can happen with server-side routing (e.g., basePath with getAgentByName) " +
                  "where the instance is determined by auth/session. " +
                  "Provide onIdentityChange callback to handle this explicitly, " +
                  "or ignore if this is expected for your routing pattern."
              );
            }
          }

          // Track for next change detection
          previousIdentityRef.current = { name: newName, agent: newAgent };

          // Call onIdentity callback
          options.onIdentity?.(newName, newAgent);
          return;
        }
        if (parsedMessage.type === MessageType.CF_AGENT_STATE) {
          setAgentState(parsedMessage.state as State);
          options.onStateUpdate?.(parsedMessage.state as State, "server");
          return;
        }
        if (parsedMessage.type === MessageType.CF_AGENT_STATE_ERROR) {
          options.onStateUpdateError?.(parsedMessage.error as string);
          return;
        }
        if (parsedMessage.type === MessageType.CF_AGENT_MCP_SERVERS) {
          options.onMcpUpdate?.(parsedMessage.mcp as MCPServersState);
          return;
        }
        if (parsedMessage.type === MessageType.RPC) {
          const response = parsedMessage as RPCResponse;
          const pending = pendingCallsRef.current.get(response.id);
          if (!pending) {
            console.warn(
              `[useAgent] Discarded an RPC response with no matching pending call (id "${response.id}"). ` +
                "The call likely timed out or was rejected when its connection closed before the response arrived."
            );
            return;
          }

          if (!response.success) {
            if (pending.timeoutId) clearTimeout(pending.timeoutId);
            pending.reject(new Error(response.error));
            pendingCallsRef.current.delete(response.id);
            pending.stream?.onError?.(response.error);
            return;
          }

          // Handle streaming responses
          if ("done" in response) {
            if (response.done) {
              if (pending.timeoutId) clearTimeout(pending.timeoutId);
              pending.resolve(response.result);
              pendingCallsRef.current.delete(response.id);
              pending.stream?.onDone?.(response.result);
            } else {
              pending.stream?.onChunk?.(response.result);
            }
          } else {
            // Non-streaming response
            if (pending.timeoutId) clearTimeout(pending.timeoutId);
            pending.resolve(response.result);
            pendingCallsRef.current.delete(response.id);
          }
          return;
        }
      }
      options.onMessage?.(message);
    },
    onClose: (event: CloseEvent) => {
      // Identify which socket actually closed. Close events are
      // dispatched asynchronously, so a close from an old socket that
      // was just replaced can arrive while a new socket is already
      // connecting (or connected). `event.target` is the PartySocket
      // that dispatched the event; fall back to the live socket if the
      // environment doesn't populate it.
      const closedSocket =
        (event.target as PartySocket | null) ?? socketRef.current;
      const isCurrentSocket = closedSocket === socketRef.current;

      // Calls transmitted on the closed socket can never receive their
      // response — reject them. Calls still queued (never transmitted)
      // stay pending and are flushed when a socket next opens; calls
      // in flight on a *different* (newer) socket are untouched.
      if (closedSocket) {
        rejectCallsSentOn(closedSocket, "Connection closed");
      }

      if (isCurrentSocket) {
        // Reset ready state for next connection
        resetReady();
        if (mutableAgentRef.current) {
          mutableAgentRef.current.identified = false;
        }
        setIdentity((prev) => ({ ...prev, identified: false }));

        // Pause reconnection for async queries until fresh query params are ready
        if (isAsyncQuery) {
          setAwaitingQueryRefresh(true);
        }

        // Invalidate cache and trigger re-render to fetch fresh query params
        deleteCacheEntry(cacheKeyRef.current);
        setCacheInvalidatedAt(Date.now());
      }

      // Call user's onClose if provided
      options.onClose?.(event);
    }
  }) as PartySocket & {
    agent: string;
    name: string;
    identified: boolean;
    ready: Promise<void>;
    state: State | undefined;
    setState: (state: State) => void;
    call: UntypedAgentMethodCall;
    stub: UntypedAgentStub;
    getHttpUrl: () => string;
  };
  // Update the live-socket ref before anything below can use it.
  socketRef.current = agent;

  // When `usePartySocket` replaces the socket object (connection options
  // changed — async query refresh, path change, enabled toggle, ...) the
  // old socket's event listeners are detached at the same commit, so its
  // final close event may never be observed by our onClose handler.
  // Sweep here instead: anything transmitted on the old socket can never
  // get a response, and the identity it established no longer applies.
  // Queued (never-transmitted) calls survive and flush when the new
  // socket opens.
  const prevSocketRef = useRef<PartySocket | null>(null);
  const prevAddressKeyRef = useRef(addressKey);
  useEffect(() => {
    const prev = prevSocketRef.current;
    prevSocketRef.current = agent;
    const prevAddress = prevAddressKeyRef.current;
    prevAddressKeyRef.current = addressKey;

    // Destination guard: if the agent address changed (different agent,
    // name, or path — not just refreshed credentials), calls that are
    // still queued were composed for the *old* instance. Reject them
    // before anything can flush them onto the new instance.
    if (prevAddress !== addressKey) {
      rejectQueuedCalls(
        "Call discarded: the agent address changed before the request could be sent"
      );
    }

    if (prev && prev !== agent) {
      rejectCallsSentOn(prev, "Connection closed");
      resetReady();
      if (mutableAgentRef.current) {
        mutableAgentRef.current.identified = false;
      }
      setIdentity((current) =>
        current.identified ? { ...current, identified: false } : current
      );
    }
    // The helpers only touch refs; re-running on socket/address change is all we need.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, addressKey]);

  // Create the call method. Deliberately dependency-free: it routes
  // through refs, so even a stale `agent` reference captured by an old
  // effect closure issues calls against the live socket.
  const call = useCallback(
    <T = unknown,>(
      method: string,
      args: unknown[] = [],
      options?: CallOptions | StreamOptions
    ): Promise<T> => {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        // Detect legacy format: { onChunk?, onDone?, onError? } vs new format: { timeout?, stream? }
        const isLegacyFormat =
          options &&
          ("onChunk" in options || "onDone" in options || "onError" in options);
        const streamOptions = isLegacyFormat
          ? (options as StreamOptions)
          : (options as CallOptions | undefined)?.stream;
        const timeout = isLegacyFormat
          ? undefined
          : (options as CallOptions | undefined)?.timeout;

        // Apply the default timeout as a backstop for non-streaming
        // calls so a lost response rejects instead of hanging forever.
        // An explicit `timeout` (including 0 = disabled) always wins.
        const effectiveTimeout =
          timeout !== undefined
            ? timeout
            : streamOptions
              ? undefined
              : defaultCallTimeoutRef.current;

        if (effectiveTimeout) {
          timeoutId = setTimeout(() => {
            const pending = pendingCallsRef.current.get(id);
            pendingCallsRef.current.delete(id);
            const errorMessage = `RPC call to ${method} timed out after ${effectiveTimeout}ms`;
            pending?.stream?.onError?.(errorMessage);
            reject(new Error(errorMessage));
          }, effectiveTimeout);
        }

        const rpcRequest: RPCRequest = {
          args,
          id,
          method,
          type: MessageType.RPC
        };
        const request = JSON.stringify(rpcRequest);

        pendingCallsRef.current.set(id, {
          reject,
          resolve: resolve as (value: unknown) => void,
          stream: streamOptions,
          timeoutId,
          request,
          sentOn: null
        });

        // Transmit immediately if the live socket is open; otherwise the
        // request stays queued and is flushed on the next open event.
        // We never hand requests to a non-open socket: its internal
        // buffer is lost forever if the socket gets replaced.
        const socket = socketRef.current;
        if (socket && socket.readyState === socket.OPEN) {
          socket.send(request);
          const pending = pendingCallsRef.current.get(id);
          if (pending) pending.sentOn = socket;
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  agent.setState = (newState: State) => {
    // Route through the live socket so stale `agent` references don't
    // write into a replaced socket's dead buffer.
    (socketRef.current ?? agent).send(
      JSON.stringify({ state: newState, type: MessageType.CF_AGENT_STATE })
    );
    setAgentState(newState);
    options.onStateUpdate?.(newState, "client");
  };

  agent.call = call;
  // Use reactive identity state (updates on identity message)
  agent.agent = identity.agent;
  agent.name = identity.name;
  // Full root-first chain including the leaf. Computed from the
  // user-provided options — the server doesn't need to echo it
  // back because the client already knows. Write past the
  // PartySocket `.path: string` shape via an unknown cast — the
  // overload signatures expose this as `ReadonlyArray<...>`.
  (
    agent as unknown as { path: ReadonlyArray<{ agent: string; name: string }> }
  ).path = fullPath;
  agent.identified = identity.identified;
  agent.ready = readyRef.current!.promise;
  agent.state = agentState;
  mutableAgentRef.current = agent;
  // Memoize stub so it's referentially stable across renders
  // (call is already stable via useCallback)
  const stub = useMemo(() => createStubProxy(call), [call]);
  agent.stub = stub;
  agent.getHttpUrl = () => {
    // TODO: upstream to partysocket — expose an HTTP URL property
    // @ts-expect-error accessing protected PartySocket internals
    const wsUrl: string = (agent._url as string | null) || agent._pkurl || "";
    return wsUrl.replace("ws://", "http://").replace("wss://", "https://");
  };

  // warn if agent isn't in lowercase
  if (identity.agent !== identity.agent.toLowerCase()) {
    console.warn(
      "Agent name: " +
        identity.agent +
        " should probably be in lowercase. Received: " +
        identity.agent
    );
  }

  // The overload signatures return `Omit<PartySocket, "path"> & { path: ... }`,
  // but `agent` is inferred as the raw PartySocket. Cast to satisfy
  // the overload contract — the runtime override of `agent.path`
  // above ensures the shape matches.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return agent as any;
}

type AgentToolEventAgent = Pick<
  PartySocket,
  "addEventListener" | "removeEventListener"
>;

function agentToolDedupeKey(message: AgentToolEventMessage): string {
  return [
    message.parentToolCallId ?? "",
    message.event.runId,
    String(message.sequence)
  ].join("\0");
}

export function useAgentToolEvents(options: { agent: AgentToolEventAgent }): {
  runsById: Record<string, AgentToolRunState>;
  runsByToolCallId: Record<string, AgentToolRunState[]>;
  unboundRuns: AgentToolRunState[];
  getRunsForToolCall(toolCallId: string): AgentToolRunState[];
  resetLocalState(): void;
} {
  const { agent } = options;
  const [state, setState] = useState<AgentToolEventState>(() =>
    createAgentToolEventState()
  );
  const seenRef = useRef(new Set<string>());

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let message: AgentToolEventMessage;
      try {
        message = JSON.parse(event.data) as AgentToolEventMessage;
      } catch {
        return;
      }
      if (message.type !== "agent-tool-event") return;
      const key = agentToolDedupeKey(message);
      if (seenRef.current.has(key)) return;
      seenRef.current.add(key);
      setState((prev) => applyAgentToolEvent(prev, message));
    };

    agent.addEventListener("message", onMessage);
    return () => agent.removeEventListener("message", onMessage);
  }, [agent]);

  const resetLocalState = useCallback(() => {
    seenRef.current.clear();
    setState(createAgentToolEventState());
  }, []);

  const getRunsForToolCall = useCallback(
    (toolCallId: string) => state.runsByToolCallId[toolCallId] ?? [],
    [state.runsByToolCallId]
  );

  return {
    ...state,
    getRunsForToolCall,
    resetLocalState
  };
}
