import type { env } from "cloudflare:workers";
import type { Agent, AgentHost } from "..";

// The `implements AgentHost` clause on Agent already enforces this at
// compile time; this assertion documents the contract from the consumer
// side — an Agent instance is usable wherever a host capability slice is
// expected.
type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

type _AgentIsAgentHost = Assert<Extends<Agent<typeof env>, AgentHost>>;

export type { _AgentIsAgentHost };
