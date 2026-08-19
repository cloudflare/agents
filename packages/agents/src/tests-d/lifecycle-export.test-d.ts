import { expectTypeOf } from "vitest";
import type {
  Connection as AgentConnection,
  ConnectionContext as AgentConnectionContext,
  RoutingRetryOptions as AgentRoutingRetryOptions,
  WSMessage as AgentWSMessage
} from "../index";
import {
  DurableObjectLifecycle,
  Server,
  type Connection,
  type ConnectionContext,
  type DurableObjectLifecycleComponent,
  type RoutingRetryOptions,
  type WSMessage
} from "../lifecycle";
import type {
  Connection as UpstreamConnection,
  ConnectionContext as UpstreamConnectionContext,
  RoutingRetryOptions as UpstreamRoutingRetryOptions,
  Server as DirectPartyServer,
  WSMessage as UpstreamWSMessage
} from "partyserver";

expectTypeOf<Server>().toEqualTypeOf<DirectPartyServer>();
expectTypeOf<Connection>().toEqualTypeOf<UpstreamConnection>();
expectTypeOf<ConnectionContext>().toEqualTypeOf<UpstreamConnectionContext>();
expectTypeOf<RoutingRetryOptions>().toEqualTypeOf<UpstreamRoutingRetryOptions>();
expectTypeOf<WSMessage>().toEqualTypeOf<UpstreamWSMessage>();

expectTypeOf<AgentConnection>().toEqualTypeOf<Connection>();
expectTypeOf<AgentConnectionContext>().toEqualTypeOf<ConnectionContext>();
expectTypeOf<AgentRoutingRetryOptions>().toEqualTypeOf<RoutingRetryOptions>();
expectTypeOf<AgentWSMessage>().toEqualTypeOf<WSMessage>();

class LifecycleTypeProbe extends Server {
  readonly #component: DurableObjectLifecycleComponent = {
    onRequest: ({ request }) => new Response(request.url)
  };

  protected override get lifecycleComponents() {
    return [this.#component];
  }
}

expectTypeOf<LifecycleTypeProbe>().toMatchTypeOf<Server>();
expectTypeOf(
  new DurableObjectLifecycle(() => [
    {
      onStart: ({ props }) => {
        expectTypeOf(props).toEqualTypeOf<object | undefined>();
      }
    }
  ])
).toEqualTypeOf<DurableObjectLifecycle<object>>();
