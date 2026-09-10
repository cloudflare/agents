import type { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { AIChatAgent } from "../index";

// Interfaces intentionally have no implicit string index signature.
interface RolePlayAgentConfig {
  readonly role: string;
  readonly temperature: number;
}

declare abstract class RolePlayChatAgent extends AIChatAgent<
  typeof env,
  unknown,
  RolePlayAgentConfig
> {}

declare const config: RolePlayAgentConfig;
declare const namespace: DurableObjectNamespace<RolePlayChatAgent>;
getAgentByName(namespace, "role-play", { props: config });

declare class PrimitivePropsAgent extends AIChatAgent<
  typeof env,
  unknown,
  // @ts-expect-error Props must be an object.
  string
> {}

export {};
