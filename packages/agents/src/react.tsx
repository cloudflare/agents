import type { PartySocket } from "partysocket";
import { usePartySocket } from "partysocket/react";
import { useCallback, useRef } from "react";
import type { MCPServersState, RPCRequest, RPCResponse, Agent } from "./";
import type { StreamOptions } from "./client";
import type { Method, RPCMethod } from "./serializable";

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

/**
 * Options for the useAgent hook
 * @template State Type of the Agent's state
 */
export type UseAgentOptions<State = unknown> = Omit<
  Parameters<typeof usePartySocket>[0],
  "party" | "room"
> & {
  /** Name of the agent to connect to */
  agent: string;
  /** Name of the specific Agent instance */
  name?: string;
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
  K extends keyof OptionalAgentMethods<AgentT>,
>(
  method: K,
  args?: Parameters<OptionalAgentMethods<AgentT>[K]>,
  streamOptions?: StreamOptions
) => AgentPromiseReturnType<AgentT, K>;

type RequiredArgsAgentMethodCall<AgentT> = <
  K extends keyof RequiredAgentMethods<AgentT>,
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
 * @template State Type of the Agent's state
 * @template Agent Type of the Agent
 * @param options Connection options
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
  State,
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

  // TODO: if options.query is a function, then use
  // "use()" to get the value and pass it
  // as a query parameter to usePartySocket
  const agent = usePartySocket({
    prefix: "agents",
    party: agentNamespace,
    room: options.name || "default",
    ...options,
    onMessage: (message) => {
      if (typeof message.data === "string") {
        let parsedMessage: Record<string, unknown>;
        try {
          parsedMessage = JSON.parse(message.data);
        } catch (error) {
          // silently ignore invalid messages for now
          // TODO: log errors with log levels
          return options.onMessage?.(message);
        }
        if (parsedMessage.type === "cf_agent_state") {
          options.onStateUpdate?.(parsedMessage.state as State, "server");
          return;
        }
        if (parsedMessage.type === "cf_agent_mcp_servers") {
          options.onMcpUpdate?.(parsedMessage.mcp as MCPServersState);
          return;
        }
        if (parsedMessage.type === "rpc") {
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
          resolve: resolve as (value: unknown) => void,
          reject,
          stream: streamOptions,
        });

        const request: RPCRequest = {
          type: "rpc",
          id,
          method,
          args,
        };

        agent.send(JSON.stringify(request));
      });
    },
    [agent]
  );

  agent.setState = (state: State) => {
    agent.send(JSON.stringify({ type: "cf_agent_state", state }));
    options.onStateUpdate?.(state, "client");
  };

  agent.call = call;
  agent.agent = agentNamespace;
  agent.name = options.name || "default";
  // biome-ignore lint: suppressions/parse
  agent.stub = new Proxy<any>(
    {},
    {
      get: (target, method) => {
        return (...args: unknown[]) => {
          return call(method as string, args);
        };
      },
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
