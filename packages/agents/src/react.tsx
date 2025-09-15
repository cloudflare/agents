import type { PartySocket } from "partysocket";
import { usePartySocket } from "partysocket/react";
import { useCallback, useRef, use, useMemo, useEffect } from "react";
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

type QueryObject = Record<string, string | number | boolean | null | undefined>;

// Simple cache for async queries
const queryCache = new Map<string, Promise<QueryObject>>();

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
  /** Called when the Agent's state is updated */
  onStateUpdate?: (state: State, source: "server" | "client") => void;
  /** Called when MCP server state is updated */
  onMcpUpdate?: (mcpServers: MCPServersState) => void;
  /** Enable debug logging */
  debug?: boolean;
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
 * React hook for connecting to an Agent with support for both sync and async queries
 *
 * This hook automatically detects whether you're using a static query object or an async function
 * and handles both cases seamlessly with proper caching and Suspense integration.
 *
 * @example
 * // Sync query (existing pattern)
 * const agent = useAgent({
 *   agent: "MyAgent",
 *   query: { token: "abc123", userId: "user1" }
 * });
 *
 * @example
 * // Async query (new pattern)
 * const agent = useAgent({
 *   agent: "MyAgent",
 *   query: async () => ({ token: await getAuthToken(), userId: await getUserId() }),
 *   queryDeps: [userId] // Dependencies for caching
 * });
 *
 * @example
 * // No query (existing pattern)
 * const agent = useAgent({
 *   agent: "MyAgent"
 * });
 *
 * @template State Type of the Agent's state
 * @template Agent Type of the Agent
 * @param options Connection options with optional sync/async query
 * @returns WebSocket connection with setState and call methods
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
  const { query, queryDeps, debug, ...restOptions } = options;

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

  // Handle both sync and async query patterns
  const cacheKey = useMemo(() => {
    const deps = queryDeps?.map((d) => String(d)).join("_") || "no-deps";
    return `agent_${agentNamespace}_${options.name || "default"}_${deps}`;
  }, [agentNamespace, options.name, queryDeps]);

  const queryPromise = useMemo(() => {
    if (!query || typeof query !== "function") {
      return null;
    }

    if (queryCache.has(cacheKey)) {
      return queryCache.get(cacheKey)!;
    }

    const promise = query().catch((error) => {
      console.error(
        `[useAgent] Query failed for agent "${options.agent}":`,
        error
      );
      queryCache.delete(cacheKey); // Remove failed promise from cache
      throw error; // Re-throw for Suspense error boundary
    });

    queryCache.set(cacheKey, promise);

    // Simple TTL cleanup after 5 minutes
    const timeoutId = setTimeout(
      () => {
        queryCache.delete(cacheKey);
      },
      5 * 60 * 1000
    );

    // Clear timeout if promise settles early
    promise.finally(() => clearTimeout(timeoutId));

    return promise;
  }, [cacheKey, query, options.agent]);

  let resolvedQuery: QueryObject | undefined;

  if (query) {
    if (typeof query === "function") {
      if (debug) {
        console.log(
          `[useAgent] Using async query for agent "${options.agent}"`
        );
      }

      // Use React's use() to resolve the promise
      const queryResult = use(queryPromise!);

      // Transform resolved data to WebSocket-compatible format
      if (queryResult) {
        const transformedQuery: Record<string, string | null | undefined> = {};
        for (const [key, value] of Object.entries(queryResult)) {
          if (value === null || value === undefined) {
            transformedQuery[key] = value;
          } else if (typeof value === "string") {
            transformedQuery[key] = value;
          } else if (typeof value === "number" || typeof value === "boolean") {
            transformedQuery[key] = String(value);
          } else {
            transformedQuery[key] = JSON.stringify(value);
          }
        }
        resolvedQuery = transformedQuery;
      }
    } else {
      // Sync query - use directly
      resolvedQuery = query;

      if (debug) {
        console.log(`[useAgent] Using sync query for agent "${options.agent}"`);
      }
    }
  }

  // Cleanup cache on unmount
  useEffect(() => {
    return () => {
      if (queryPromise && queryCache.get(cacheKey) === queryPromise) {
        queryCache.delete(cacheKey);
      }
    };
  }, [cacheKey, queryPromise]);

  const agent = usePartySocket({
    party: agentNamespace,
    prefix: "agents",
    room: options.name || "default",
    query: resolvedQuery as Record<string, string | null | undefined>,
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

// No additional exports needed - useAgent now handles everything internally
