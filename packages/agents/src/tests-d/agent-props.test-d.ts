import type { env } from "cloudflare:workers";
import {
  Agent,
  getAgentByName,
  routeAgentRequest,
  type AgentGetOptions,
  type AgentNamespace,
  type AgentOptions,
  type EmailRoutingOptions
} from "../index";
import type { Lifecycle, LifecycleObject } from "../lifecycle";
import { RoutedAgents } from "../routing";
import { AgentWorkflow } from "../workflows";

// Interfaces intentionally have no implicit string index signature.
interface RolePlayAgentConfig {
  readonly role: string;
  readonly temperature: number;
}

interface RolePlayAgentState {
  readonly turnCount: number;
}

declare const config: RolePlayAgentConfig;
declare const workerEnv: typeof env;

class RolePlayAgent extends Agent<
  typeof env,
  RolePlayAgentState,
  RolePlayAgentConfig
> {
  override onStart(props?: RolePlayAgentConfig): void {
    props?.role satisfies string | undefined;
  }
}

// The exact shape reported in #1886: an untyped namespace and interface props.
declare const namespace: DurableObjectNamespace<Agent<typeof env>>;
getAgentByName(namespace, "role-play", { props: config });

// Typed namespaces, inferred and with explicit type arguments.
declare const rolePlayNamespace: DurableObjectNamespace<RolePlayAgent>;
getAgentByName(rolePlayNamespace, "role-play", { props: config });
getAgentByName<typeof env, RolePlayAgent>(rolePlayNamespace, "role-play", {
  props: config
});

// The documented binding alias accepts an Agent with interface props.
declare const rolePlayBinding: AgentNamespace<RolePlayAgent>;
getAgentByName(rolePlayBinding, "role-play", { props: config });

// Option aliases with and without explicit Props.
const getOptions: AgentGetOptions<typeof env> = { props: config };
getOptions.props satisfies object | undefined;
const typedGetOptions: AgentGetOptions<typeof env, RolePlayAgentConfig> = {
  props: config
};
typedGetOptions.props satisfies RolePlayAgentConfig | undefined;

const routeOptions: AgentOptions<typeof env> = { props: config };
routeAgentRequest(new Request("https://example.com"), workerEnv, routeOptions);
routeAgentRequest<typeof env>(new Request("https://example.com"), workerEnv, {
  props: config
});

declare const resolver: EmailRoutingOptions<typeof env>["resolver"];
const emailOptions: EmailRoutingOptions<typeof env> = {
  resolver,
  props: config
};
emailOptions.props satisfies object | undefined;

// Composition APIs bounded by bare `Agent`.
declare const host: Agent<typeof env>;
void host.subAgent(RolePlayAgent, "child");
void host.parentAgent(RolePlayAgent);
host.hasSubAgent(RolePlayAgent, "child");
host.listSubAgents(RolePlayAgent);

declare const routed: RoutedAgents<RolePlayAgent>;
routed satisfies RoutedAgents<RolePlayAgent>;

declare abstract class RolePlayWorkflow extends AgentWorkflow<RolePlayAgent> {}

// Lifecycle composition.
type RolePlayLifecycle = Lifecycle<typeof env, RolePlayAgentConfig>;
declare const lifecycle: RolePlayLifecycle;
lifecycle.start(config);

type RolePlayLifecycleObject = LifecycleObject<typeof env, RolePlayAgentConfig>;
declare const lifecycleObject: RolePlayLifecycleObject;
lifecycleObject.onStart?.(config);

// Primitive props remain rejected everywhere.
// @ts-expect-error Props must be an object.
declare class PrimitivePropsAgent extends Agent<typeof env, unknown, string> {}

getAgentByName(namespace, "role-play", {
  // @ts-expect-error Props must be an object.
  props: "not-an-object"
});

routeAgentRequest(new Request("https://example.com"), workerEnv, {
  // @ts-expect-error Props must be an object.
  props: 42
});

export {};
