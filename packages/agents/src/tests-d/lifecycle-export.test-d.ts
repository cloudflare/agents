import { DurableObject } from "cloudflare:workers";
import { expectTypeOf } from "vitest";
import type {
  Connection as AgentConnection,
  ConnectionContext as AgentConnectionContext,
  WSMessage as AgentWSMessage
} from "../index";
import {
  Lifecycle,
  type CapabilityPhaseContext,
  type Connection,
  type ConnectionContext,
  type DurableObjectCapability,
  type LifecycleOptions,
  type WSMessage
} from "../lifecycle";

expectTypeOf<AgentConnection>().toEqualTypeOf<Connection>();
expectTypeOf<AgentConnectionContext>().toEqualTypeOf<ConnectionContext>();
expectTypeOf<AgentWSMessage>().toEqualTypeOf<WSMessage>();

class LifecycleTypeProbe extends DurableObject {
  readonly lifecycle = Lifecycle.install(this);

  onRequest(request: Request): Response {
    return new Response(request.url);
  }
}

expectTypeOf<LifecycleTypeProbe>().toMatchTypeOf<DurableObject>();
expectTypeOf<LifecycleTypeProbe["lifecycle"]>().toEqualTypeOf<Lifecycle>();

const capability: DurableObjectCapability = {
  onStart: ({ props }) => {
    expectTypeOf(props).toEqualTypeOf<object | undefined>();
  },
  onRequest: ({ request }) => new Response(request.url)
};

expectTypeOf(capability).toMatchTypeOf<DurableObjectCapability>();

type ProbeProps = { label: string };
const options: LifecycleOptions<ProbeProps> = {
  runCapabilityPhase: async (context, operation) => {
    expectTypeOf(context).toEqualTypeOf<CapabilityPhaseContext<ProbeProps>>();
    if (context.phase === "request") {
      expectTypeOf(context.request).toEqualTypeOf<Request>();
    }
    if (context.phase === "start") {
      expectTypeOf(context.props).toEqualTypeOf<ProbeProps | undefined>();
    }
    return operation();
  }
};

class ConfiguredLifecycleTypeProbe extends DurableObject {
  readonly lifecycle = Lifecycle.install(this, options);
}

expectTypeOf<ConfiguredLifecycleTypeProbe["lifecycle"]>().toEqualTypeOf<
  Lifecycle<Cloudflare.Env, ProbeProps>
>();
