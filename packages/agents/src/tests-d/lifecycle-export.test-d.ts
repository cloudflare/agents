import { DurableObject } from "cloudflare:workers";
import { expectTypeOf } from "vitest";
import type {
  Connection as AgentConnection,
  ConnectionContext as AgentConnectionContext,
  RoutingRetryOptions as AgentRoutingRetryOptions,
  WSMessage as AgentWSMessage
} from "../index";
import {
  Lifecycle,
  type Connection,
  type ConnectionContext,
  type DurableObjectCapability,
  type RoutingRetryOptions,
  type WSMessage
} from "../lifecycle";

expectTypeOf<AgentConnection>().toEqualTypeOf<Connection>();
expectTypeOf<AgentConnectionContext>().toEqualTypeOf<ConnectionContext>();
expectTypeOf<AgentRoutingRetryOptions>().toEqualTypeOf<RoutingRetryOptions>();
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
