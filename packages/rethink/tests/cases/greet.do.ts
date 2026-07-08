import { DurableObject } from "cloudflare:workers";
import { greet } from "../../src/greet";

export class GreetingDurableObject extends DurableObject {
  fetch(_request: Request) {
    return new Response(greet("durable object"));
  }
}
