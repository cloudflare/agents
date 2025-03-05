import type { PartySocket } from "partysocket";
import { usePartySocket } from "partysocket/react";

export const agentStatePrefix = "cf_agent_state";

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
 * @returns WebSocket connection with setState method
 */
export function useAgent<State = unknown>(
  options: UseAgentOptions<State>
): PartySocket & { setState: (state: State) => void } {
  const agent = usePartySocket({
    prefix: "agents",
    party: options.agent,
    room: options.name || "default",
    ...options,
    onMessage: (message) => {
      if (
        typeof message.data === "string" &&
        message.data.startsWith(`${agentStatePrefix}:`)
      ) {
        const parsedMessage = JSON.parse(message.data.slice(15));
        options.onStateUpdate?.(parsedMessage.state, "server");
        return;
      }
      options.onMessage?.(message);
    },
  }) as PartySocket & { setState: (state: State) => void };

  agent.setState = (state: State) => {
    agent.send(
      `${agentStatePrefix}:${JSON.stringify({ type: agentStatePrefix, state })}`
    );
    options.onStateUpdate?.(state, "client");
  };

  return agent;
}
