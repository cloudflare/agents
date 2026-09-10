import type { env } from "cloudflare:workers";
import {
  Agent,
  getAgentByName,
  routeAgentRequest,
  type AgentGetOptions,
  type AgentOptions
} from "../index";
import { Lifecycle, type LifecycleObject } from "../lifecycle";
import { McpAgent } from "../mcp";

// Interfaces intentionally have no implicit string index signature.
interface RolePlayAgentConfig {
  readonly role: string;
  readonly temperature: number;
}

interface RolePlayAgentState {
  readonly turnCount: number;
}

declare const config: RolePlayAgentConfig;
declare const namespace: DurableObjectNamespace<Agent<typeof env>>;

getAgentByName(namespace, "role-play", { props: config });

class RolePlayAgent extends Agent<
  typeof env,
  RolePlayAgentState,
  RolePlayAgentConfig
> {
  override onStart(props?: RolePlayAgentConfig): void {
    props?.role satisfies string | undefined;
  }
}

declare const rolePlayNamespace: DurableObjectNamespace<RolePlayAgent>;
getAgentByName(rolePlayNamespace, "role-play", { props: config });

type RolePlayAgentOptions = AgentGetOptions<typeof env, RolePlayAgentConfig>;
declare const options: RolePlayAgentOptions;
options.props satisfies RolePlayAgentConfig | undefined;

type RolePlayRouteOptions = AgentOptions<typeof env, RolePlayAgentConfig>;
declare const routeOptions: RolePlayRouteOptions;
declare const routeEnv: typeof env;
routeAgentRequest(new Request("https://example.com"), routeEnv, routeOptions);

declare abstract class RolePlayMcpAgent extends McpAgent<
  typeof env,
  unknown,
  RolePlayAgentConfig
> {}

type RolePlayLifecycle = Lifecycle<typeof env, RolePlayAgentConfig>;
declare const lifecycle: RolePlayLifecycle;
lifecycle.start(config);

type RolePlayLifecycleObject = LifecycleObject<typeof env, RolePlayAgentConfig>;
declare const lifecycleObject: RolePlayLifecycleObject;
lifecycleObject.onStart?.(config);

// @ts-expect-error Props must be an object.
declare class PrimitivePropsAgent extends Agent<typeof env, unknown, string> {}

getAgentByName(namespace, "role-play", {
  // @ts-expect-error Props must be an object.
  props: "not-an-object"
});

export {};
