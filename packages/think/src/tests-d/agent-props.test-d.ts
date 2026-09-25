import type { env } from "cloudflare:workers";
import { getAgentByName, type AgentNamespace } from "agents";
import { Think } from "../think";

// Interfaces intentionally have no implicit string index signature.
interface RolePlayAgentConfig {
  readonly role: string;
  readonly temperature: number;
}

declare abstract class RolePlayThink extends Think<
  typeof env,
  unknown,
  RolePlayAgentConfig
> {}

declare const config: RolePlayAgentConfig;
declare const namespace: AgentNamespace<RolePlayThink>;
getAgentByName(namespace, "role-play", { props: config });

declare class PrimitivePropsThink extends Think<
  typeof env,
  unknown,
  // @ts-expect-error Props must be an object.
  string
> {}

export {};
