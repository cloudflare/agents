import type { Agent } from "./index";
import {
  durableObjectGetOptions,
  retryDurableObjectOperation,
  type DurableObjectRouteOptions
} from "./lifecycle/durable-object-lifecycle";

/** Options for resolving and starting a named Agent. */
export type AgentGetOptions<
  Env,
  Props extends Record<string, unknown> = Record<string, unknown>
> = Pick<
  DurableObjectRouteOptions<Env, Props>,
  "jurisdiction" | "locationHint" | "props" | "routingRetry"
>;

/**
 * Get a named Agent stub after its lifecycle startup has completed.
 *
 * @param namespace - Agent Durable Object namespace.
 * @param name - Agent instance name.
 * @param options - Placement, startup properties, and retry options.
 * @returns The initialized Agent stub.
 */
export async function getAgentByName<
  Env extends Cloudflare.Env = Cloudflare.Env,
  T extends Agent<Env> = Agent<Env>,
  Props extends Record<string, unknown> = Record<string, unknown>
>(
  namespace: DurableObjectNamespace<T>,
  name: string,
  options?: AgentGetOptions<Env, Props>
): Promise<DurableObjectStub<T>> {
  const target = options?.jurisdiction
    ? namespace.jurisdiction(options.jurisdiction)
    : namespace;
  const id = target.idFromName(name);
  const stub = target.get(id, durableObjectGetOptions(options));

  // SAFETY: Agent exposes this internal initializer specifically for native
  // RPC calls, which bypass the lifecycle-installed fetch handler.
  const lifecycleStub = stub as unknown as {
    __unsafe_ensureInitialized(props?: Props): Promise<void>;
  };
  await retryDurableObjectOperation(
    () => lifecycleStub.__unsafe_ensureInitialized(options?.props),
    { name },
    options?.routingRetry
  );

  return stub;
}
