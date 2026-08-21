import { DurableObject } from "cloudflare:workers";
import { expectTypeOf } from "vitest";
import {
  routeAgentRequest,
  type AgentOptions,
  type RoutingRetryOptions
} from "../index";

class PlainRoutedObject extends DurableObject {
  onRequest(): Response {
    return new Response("ok");
  }
}

type RoutingEnv = {
  PlainRoutedObject: DurableObjectNamespace<PlainRoutedObject>;
};

declare const env: RoutingEnv;

expectTypeOf(
  routeAgentRequest(new Request("https://example.com"), env)
).toEqualTypeOf<Promise<Response | null>>();

expectTypeOf<AgentOptions<RoutingEnv>>().toMatchTypeOf<{
  prefix?: string;
  routingRetry?: false | RoutingRetryOptions;
}>();
