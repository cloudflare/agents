import type { PartySocket } from "partysocket";
import { usePartySocket } from "partysocket/react";
import { useCallback, useRef, use, useMemo, useState, useEffect } from "react";
import type { MCPServersState, RPCRequest, RPCResponse } from "./";
import type {
  AgentPromiseReturnType,
  AgentStub,
  OptionalAgentMethods,
  RequiredAgentMethods,
  StreamOptions,
  UntypedAgentStub
} from "./client";
import { createStubProxy } from "./client";
import { camelCaseToKebabCase } from "./utils";
import { MessageType } from "./types";

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
};

type OptionalArgsAgentMethodCall<AgentT> = <
  K extends keyof OptionalAgentMethods<AgentT>
>(
  method: K,
  args?: Parameters<OptionalAgentMethods<AgentT>[K]>,
  streamOptions?: StreamOptions
) => AgentPromiseReturnType<AgentT, K>;

type RequiredArgsAgentMethodCall<AgentT> = <
  K extends keyof RequiredAgentMethods<AgentT>
>(
  method: K,
  args: Parameters<RequiredAgentMethods<AgentT>[K]>,
  streamOptions?: StreamOptions
) => AgentPromiseReturnType<AgentT, K>;

type AgentMethodCall<AgentT> = OptionalArgsAgentMethodCall<AgentT> &
  RequiredArgsAgentMethodCall<AgentT>;

type UntypedAgentMethodCall = <T = unknown>(
  method: string,
  args?: unknown[],
  streamOptions?: StreamOptions
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
  const {
    query,
    queryDeps,
    cacheTtl,
    sub: subOption,
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

  // Keep track of pending RPC calls
  const pendingCallsRef = useRef(
    new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        stream?: StreamOptions;
      }
    >()
  );

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

  // Combine the sub-agent chain with the user-provided `path`.
  // Order matters: `/sub/{child}/{name}/...` comes before `path` so
  // the server sees the hierarchy it expects.
  const combinedPath = useMemo(
    () => buildSubPath(subChain, options.path),
    [subChain, options.path]
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

  const agent = usePartySocket({
    ...socketOptions,
    enabled: socketEnabled,
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
          if (!pending) return;

          if (!response.success) {
            pending.reject(new Error(response.error));
            pendingCallsRef.current.delete(response.id);
            pending.stream?.onError?.(response.error);
            return;
          }

          // Handle streaming responses
          if ("done" in response) {
            if (response.done) {
              pending.resolve(response.result);
              pendingCallsRef.current.delete(response.id);
              pending.stream?.onDone?.(response.result);
            } else {
              pending.stream?.onChunk?.(response.result);
            }
          } else {
            // Non-streaming response
            pending.resolve(response.result);
            pendingCallsRef.current.delete(response.id);
          }
          return;
        }
      }
      options.onMessage?.(message);
    },
    onClose: (event: CloseEvent) => {
      // Reset ready state for next connection
      resetReady();
      setIdentity((prev) => ({ ...prev, identified: false }));

      // Pause reconnection for async queries until fresh query params are ready
      if (isAsyncQuery) {
        setAwaitingQueryRefresh(true);
      }

      // Invalidate cache and trigger re-render to fetch fresh query params
      deleteCacheEntry(cacheKeyRef.current);
      setCacheInvalidatedAt(Date.now());

      // Reject all pending calls (consistent with AgentClient behavior)
      const error = new Error("Connection closed");
      for (const pending of pendingCallsRef.current.values()) {
        pending.reject(error);
        pending.stream?.onError?.("Connection closed");
      }
      pendingCallsRef.current.clear();

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
  // Create the call method
  const call = useCallback(
    <T = unknown,>(
      method: string,
      args: unknown[] = [],
      streamOptions?: StreamOptions
    ): Promise<T> => {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        pendingCallsRef.current.set(id, {
          reject,
          resolve: resolve as (value: unknown) => void,
          stream: streamOptions
        });

        const request: RPCRequest = {
          args,
          id,
          method,
          type: MessageType.RPC
        };

        agent.send(JSON.stringify(request));
      });
    },
    [agent]
  );

  agent.setState = (newState: State) => {
    agent.send(
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
