import {
  PartySocket,
  type PartySocketOptions,
  type PartyFetchOptions,
} from "partysocket";

/**
 * Options for creating an AgentClient
 */
export type AgentClientOptions = Omit<PartySocketOptions, "party" | "room"> & {
  /** Name of the agent to connect to */
  agent: string;
  /** Name of the specific Agent instance */
  name?: string;
};

/**
 * Options for the agentFetch function
 */
export type AgentClientFetchOptions = Omit<
  PartyFetchOptions,
  "party" | "room"
> & {
  /** Name of the agent to connect to */
  agent: string;
  /** Name of the specific Agent instance */
  name?: string;
};

/**
 * WebSocket client for connecting to an Agent
 */
export class AgentClient extends PartySocket {
  static fetch(opts: PartyFetchOptions): Promise<Response> {
    throw new Error(
      "AgentClient.fetch is not implemented, use agentFetch instead"
    );
  }
  constructor(opts: AgentClientOptions) {
    super({
      prefix: "agents",
      party: opts.agent,
      room: opts.name || "default",
      ...opts,
    });
  }
}

/**
 * Make an HTTP request to an Agent
 * @param opts Connection options
 * @param init Request initialization options
 * @returns Promise resolving to a Response
 */
export function agentFetch(opts: AgentClientFetchOptions, init?: RequestInit) {
  return PartySocket.fetch(
    {
      prefix: "agents",
      party: opts.agent,
      room: opts.name || "default",
      ...opts,
    },
    init
  );
}
