import type { PartySocket } from "partysocket";
import { usePartySocket } from "partysocket/react";
import { useCallback, useRef, use, useMemo, useEffect, useState } from "react";
import type { Agent, MCPServersState, RPCRequest, RPCResponse } from "./";
import type { StreamOptions } from "./client";
import type { Method, RPCMethod } from "./serializable";
import { MessageType } from "./ai-types";

/**
 * Convert a camelCase string to a kebab-case string
 * @param str The string to convert
 * @returns The kebab-case string
 */
function camelCaseToKebabCase(str: string): string {
  // If string is all uppercase, convert to lowercase
  if (str === str.toUpperCase() && str !== str.toLowerCase()) {
    return str.toLowerCase().replace(/_/g, "-");
  }

  // Otherwise handle camelCase to kebab-case
  let kebabified = str.replace(
    /[A-Z]/g,
    (letter) => `-${letter.toLowerCase()}`
  );
  kebabified = kebabified.startsWith("-") ? kebabified.slice(1) : kebabified;
  // Convert any remaining underscores to hyphens and remove trailing -'s
  return kebabified.replace(/_/g, "-").replace(/-$/, "");
}

type QueryObject = Record<string, string | null>;
interface CacheEntry {
  promise: Promise<QueryObject>;
  expiresAt: number;
}

const queryCache = new Map<string, CacheEntry>();

function createCacheKey(
  agentNamespace: string,
  name: string | undefined,
  deps: unknown[]
): string {
  return JSON.stringify([agentNamespace, name || "default", ...deps]);
}

function getCacheEntry(key: string): CacheEntry | undefined {
  const entry = queryCache.get(key);
  if (!entry) return undefined;

  if (Date.now() > entry.expiresAt) {
    queryCache.delete(key);
    return undefined;
  }

  return entry;
}

function setCacheEntry(
  key: string,
  promise: Promise<QueryObject>,
  cacheTtl?: number
): CacheEntry {
  const expiresAt = Date.now() + (cacheTtl ?? 5 * 60 * 1000);
  const entry = { promise, expiresAt };
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
  clearCache: () => queryCache.clear()
};

/**
 * Options for the useAgent hook
 * @template State Type of the Agent's state
 */
export type UseAgentOptions<State = unknown> = Omit<
  Parameters<typeof usePartySocket>[0],
  "party" | "room" | "query"
> & {
  /** Name of the agent to connect to */
  agent: string;
  /** Name of the specific Agent instance */
  name?: string;
  /** Query parameters - can be static object or async function */
  query?: QueryObject | (() => Promise<QueryObject>);
  /** Dependencies for async query caching */
  queryDeps?: unknown[];
  /** Cache TTL in milliseconds for auth tokens/time-sensitive data */
  cacheTtl?: number;
  /** Called when the Agent's state is updated */
  onStateUpdate?: (state: State, source: "server" | "client") => void;
  /** Called when MCP server state is updated */
  onMcpUpdate?: (mcpServers: MCPServersState) => void;
};

type AllOptional<T> = T extends [infer A, ...infer R]
  ? undefined extends A
    ? AllOptional<R>
    : false
  : true; // no params means optional by default

type RPCMethods<T> = {
  [K in keyof T as T[K] extends RPCMethod<T[K]> ? K : never]: RPCMethod<T[K]>;
};

type OptionalParametersMethod<T extends RPCMethod> =
  AllOptional<Parameters<T>> extends true ? T : never;

// all methods of the Agent, excluding the ones that are declared in the base Agent class
// biome-ignore lint: suppressions/parse
type AgentMethods<T> = Omit<RPCMethods<T>, keyof Agent<any, any>>;

type OptionalAgentMethods<T> = {
  [K in keyof AgentMethods<T> as AgentMethods<T>[K] extends OptionalParametersMethod<
    AgentMethods<T>[K]
  >
    ? K
    : never]: OptionalParametersMethod<AgentMethods<T>[K]>;
};

type RequiredAgentMethods<T> = Omit<
  AgentMethods<T>,
  keyof OptionalAgentMethods<T>
>;

type AgentPromiseReturnType<T, K extends keyof AgentMethods<T>> =
  // biome-ignore lint: suppressions/parse
  ReturnType<AgentMethods<T>[K]> extends Promise<any>
    ? ReturnType<AgentMethods<T>[K]>
    : Promise<ReturnType<AgentMethods<T>[K]>>;

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

type AgentStub<T> = {
  [K in keyof AgentMethods<T>]: (
    ...args: Parameters<AgentMethods<T>[K]>
  ) => AgentPromiseReturnType<AgentMethods<T>, K>;
};

// we neet to use Method instead of RPCMethod here for retro-compatibility
type UntypedAgentStub = Record<string, Method>;

/**
 * React hook for connecting to an Agent
 */
export function useAgent<State = unknown>(
  options: UseAgentOptions<State>
): PartySocket & {
  agent: string;
  name: string;
  setState: (state: State) => void;
  call: UntypedAgentMethodCall;
  stub: UntypedAgentStub;
};
export function useAgent<
  AgentT extends {
    get state(): State;
  },
  State
>(
  options: UseAgentOptions<State>
): PartySocket & {
  agent: string;
  name: string;
  setState: (state: State) => void;
  call: AgentMethodCall<AgentT>;
  stub: AgentStub<AgentT>;
};
export function useAgent<State>(
  options: UseAgentOptions<unknown>
): PartySocket & {
  agent: string;
  name: string;
  setState: (state: State) => void;
  call: UntypedAgentMethodCall | AgentMethodCall<unknown>;
  stub: UntypedAgentStub;
} {
  const agentNamespace = camelCaseToKebabCase(options.agent);
  const { query, queryDeps, cacheTtl, ...restOptions } = options;

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
    () => createCacheKey(agentNamespace, options.name, queryDeps || []),
    [agentNamespace, options.name, queryDeps]
  );

  // Track when we need to refresh the cache
  const [refreshToken, setRefreshToken] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken intentionally triggers re-computation when TTL expires
  const queryPromise = useMemo(() => {
    if (!query || typeof query !== "function") {
      return null;
    }

    const cached = getCacheEntry(cacheKey);
    if (cached) {
      return cached;
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

    return setCacheEntry(cacheKey, promise, cacheTtl);
  }, [cacheKey, query, options.agent, cacheTtl, refreshToken]);

  // Schedule refresh when TTL expires
  useEffect(() => {
    if (!queryPromise) return;

    const timeUntilExpiry = queryPromise.expiresAt - Date.now();
    if (timeUntilExpiry <= 0) {
      setRefreshToken((t) => t + 1);
      return;
    }

    const timer = setTimeout(() => {
      setRefreshToken((t) => t + 1);
    }, timeUntilExpiry);

    return () => clearTimeout(timer);
  }, [queryPromise]);

  let resolvedQuery: QueryObject | undefined;

  if (query) {
    if (typeof query === "function") {
      // Use React's use() to resolve the promise
      const queryResult = use(queryPromise!.promise);

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

  const agent = usePartySocket({
    party: agentNamespace,
    prefix: "agents",
    room: options.name || "default",
    query: resolvedQuery,
    ...restOptions,
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
        if (parsedMessage.type === MessageType.CF_AGENT_STATE) {
          options.onStateUpdate?.(parsedMessage.state as State, "server");
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
    }
  }) as PartySocket & {
    agent: string;
    name: string;
    setState: (state: State) => void;
    call: UntypedAgentMethodCall;
    stub: UntypedAgentStub;
  };
  // Create the call method
  const call = useCallback(
    <T = unknown,>(
      method: string,
      args: unknown[] = [],
      streamOptions?: StreamOptions
    ): Promise<T> => {
      return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
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

  agent.setState = (state: State) => {
    agent.send(JSON.stringify({ state, type: MessageType.CF_AGENT_STATE }));
    options.onStateUpdate?.(state, "client");
  };

  agent.call = call;
  agent.agent = agentNamespace;
  agent.name = options.name || "default";
  // biome-ignore lint: suppressions/parse
  agent.stub = new Proxy<any>(
    {},
    {
      get: (_target, method) => {
        return (...args: unknown[]) => {
          return call(method as string, args);
        };
      }
    }
  );

  // warn if agent isn't in lowercase
  if (agent.agent !== agent.agent.toLowerCase()) {
    console.warn(
      `Agent name: ${agent.agent} should probably be in lowercase. Received: ${agent.agent}`
    );
  }

  return agent;
}
