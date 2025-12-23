import type { PartySocket } from "partysocket";
import { usePartySocket } from "partysocket/react";
import { useCallback, useRef, use, useMemo, useState, useEffect } from "react";
import type { Agent, MCPServersState, RPCRequest, RPCResponse } from "./";
import type { StreamOptions } from "./client";
import { MessageType } from "./ai-types";
import type {
  AllSerializableValues,
  SerializableReturnValue,
  SerializableValue
} from "./serializable";

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

// biome-ignore lint: suppressions/parse
type Method = (...args: any[]) => any;

type NonStreamingRPCMethod<T extends Method> =
  AllSerializableValues<Parameters<T>> extends true
    ? ReturnType<T> extends SerializableReturnValue
      ? T
      : never
    : never;

interface StreamingResponse<
  Chunk extends SerializableValue | unknown = unknown,
  Done extends SerializableValue | unknown = unknown
> {
  send(chunk: Chunk): void;
  end(finalChunk?: Done): void;
}

type StreamingRPCMethod<T extends Method> = T extends (
  arg: infer A,
  ...rest: infer R
) => void | Promise<void>
  ? A extends StreamingResponse<SerializableValue, SerializableValue>
    ? AllSerializableValues<R> extends true
      ? T
      : never
    : never
  : never;

type RPCMethod<T extends Method> =
  T extends NonStreamingRPCMethod<T>
    ? NonStreamingRPCMethod<T>
    : T extends StreamingRPCMethod<T>
      ? StreamingRPCMethod<T>
      : never;

type RPCMethods<T> = {
  [K in keyof T as T[K] extends Method ? K : never]: T[K] extends Method
    ? RPCMethod<T[K]>
    : never;
};

type AllOptional<T> = T extends [infer A, ...infer R]
  ? undefined extends A
    ? AllOptional<R>
    : false
  : true; // no params means optional by default

type StreamOptionsFrom<StreamingResponseT> =
  StreamingResponseT extends StreamingResponse<
    infer T extends SerializableValue,
    infer U extends SerializableValue
  >
    ? StreamOptions<T, U>
    : never;

type ReturnAndChunkTypesFrom<StreamingResponseT extends StreamingResponse> =
  StreamingResponseT extends StreamingResponse<
    infer Chunk extends SerializableValue,
    infer Done extends SerializableValue
  >
    ? [Chunk, Done]
    : never;

type RestParameters<T extends Method> =
  Parameters<StreamingRPCMethod<T>> extends [unknown, ...infer Rest]
    ? Rest
    : never;

type OptionalParametersMethod<T extends Method> =
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

type StreamingAgentMethods<T> = {
  [K in keyof AgentMethods<T> as AgentMethods<T>[K] extends StreamingRPCMethod<
    AgentMethods<T>[K]
  >
    ? K
    : never]: StreamingRPCMethod<AgentMethods<T>[K]>;
};

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

type StreamingAgentMethodCall<AgentT> = <
  K extends keyof StreamingAgentMethods<AgentT>
>(
  method: K,
  args: RestParameters<StreamingAgentMethods<AgentT>[K]>,
  streamOptions: StreamOptionsFrom<
    Parameters<StreamingAgentMethods<AgentT>[K]>[0]
  >
) => void;

type AgentMethodCall<AgentT> = StreamingAgentMethodCall<AgentT> &
  OptionalArgsAgentMethodCall<AgentT> &
  RequiredArgsAgentMethodCall<AgentT>;

type UntypedAgentMethodCall = <T = unknown>(
  method: string,
  args?: unknown[],
  streamOptions?: StreamOptions
) => Promise<T>;

type AgentStub<T> = {
  [K in keyof AgentMethods<T>]: AgentMethods<T>[K] extends NonStreamingRPCMethod<
    AgentMethods<T>[K]
  >
    ? (
        ...args: Parameters<AgentMethods<T>[K]>
      ) => AgentPromiseReturnType<AgentMethods<T>, K>
    : never;
};

type AgentStreamingStub<T> = {
  [K in keyof AgentMethods<T>]: AgentMethods<T>[K] extends StreamingRPCMethod<
    AgentMethods<T>[K]
  >
    ? (
        ...args: RestParameters<AgentMethods<T>[K]>
      ) => AsyncGenerator<
        ReturnAndChunkTypesFrom<
          Parameters<StreamingRPCMethod<AgentMethods<T>[K]>>[0]
        >[0],
        ReturnAndChunkTypesFrom<
          Parameters<StreamingRPCMethod<AgentMethods<T>[K]>>[0]
        >[1]
      >
    : never;
};

// we neet to use Method instead of RPCMethod here for retro-compatibility
type UntypedAgentStub = Record<string, Method>;
type UntypedAgentStreamingStub = StreamingAgentMethods<unknown>;

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
  streamingStub: UntypedAgentStreamingStub;
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
  streamingStub: AgentStreamingStub<AgentT>;
};
export function useAgent<State>(
  options: UseAgentOptions<unknown>
): PartySocket & {
  agent: string;
  name: string;
  setState: (state: State) => void;
  call: UntypedAgentMethodCall;
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

  const ttl = cacheTtl ?? 5 * 60 * 1000;

  // Track cache invalidation to force re-render when TTL expires
  const [cacheInvalidatedAt, setCacheInvalidatedAt] = useState<number>(0);

  // Get or create the query promise
  // biome-ignore lint/correctness/useExhaustiveDependencies: cacheInvalidatedAt intentionally forces re-evaluation when TTL expires
  const queryPromise = useMemo(() => {
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
    streamingStub: UntypedAgentStreamingStub;
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
  // biome-ignore lint: suppressions/parse
  agent.streamingStub = new Proxy<any>(
    {},
    {
      get: (_target, method) => {
        return async function* (...args: unknown[]) {
          let resolve: (value: unknown) => void;
          let reject: (reason: unknown) => void;
          let promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
          });

          // 4. State flags
          let isDone = false;

          // 5. Callback implementation
          const streamOptions: StreamOptions = {
            onChunk: (chunk: unknown) => {
              resolve(chunk);
              promise = new Promise((res, rej) => {
                resolve = res;
                reject = rej;
              });
            },
            onError: (error: unknown) => {
              isDone = true;
              reject(error);
            },
            onDone: (done: unknown) => {
              isDone = true;
              resolve(done);
            }
          };

          call(method as string, args, streamOptions);

          while (!isDone) {
            const result = await promise;
            if (isDone) {
              return result;
            } else {
              yield result;
            }
          }
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
