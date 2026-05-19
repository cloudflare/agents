import type { Agent } from "agents";
import type { ChatStateAgent } from "./agent";

export interface AgentStateAdapterOptions {
  parent: Agent;
  agent?: typeof ChatStateAgent;
  name?: string;
  keyShard?: (key: string) => string | undefined;
  shardKey?: (threadId: string) => string;
}
