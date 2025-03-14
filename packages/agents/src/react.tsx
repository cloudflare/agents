import type { PartySocket } from "partysocket";
import { usePartySocket } from "partysocket/react";
import { useCallback, useRef } from "react";
import type { RPCRequest, RPCResponse } from "./";
import type { StreamOptions } from "./client";

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
};

/**
 * React hook for connecting to an Agent
 * @template State Type of the Agent's state
 * @param options Connection options
 * @returns WebSocket connection with setState and call methods
 */
export function useAgent<State = unknown>(
  options: UseAgentOptions<State>
): PartySocket & {
  agent: string;
  name: string;
  setState: (state: State) => void;
  call: <T = unknown>(
    method: string,
    args?: unknown[],
    streamOptions?: StreamOptions
  ) => Promise<T>;
} {
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
    []
  );

  const agent = usePartySocket({
    prefix: "agents",
    party: options.agent,
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
          return;
        }
        if (parsedMessage.type === "cf_agent_state") {
          options.onStateUpdate?.(parsedMessage.state as State, "server");
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
    call: <T = unknown>(
      method: string,
      args?: unknown[],
      streamOptions?: StreamOptions
    ) => Promise<T>;
  };

  agent.setState = (state: State) => {
    agent.send(JSON.stringify({ type: "cf_agent_state", state }));
    options.onStateUpdate?.(state, "client");
  };

  agent.call = call;
  agent.agent = options.agent;
  agent.name = options.name || "default";

  // warn if agent or name isn't in lowercase
  if (agent.agent !== agent.agent.toLowerCase()) {
    console.warn(
      `Agent name: ${agent.agent} should probably be in lowercase. Received: ${agent.agent}`
    );
  }
  if (agent.name !== agent.name.toLowerCase()) {
    console.warn(
      `Agent instance name: ${agent.name} should probably be in lowercase. Received: ${agent.name}`
    );
  }

  return agent;
}
