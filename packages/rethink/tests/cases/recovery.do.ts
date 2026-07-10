import { DurableObject } from "cloudflare:workers";
import { greet } from "../../src/greet";

export class RecoveryDurableObject extends DurableObject {
  async flakyFunc(result: "success" | "error", duration: number) {
    await new Promise((resolve) => setTimeout(resolve, duration));

    if (result === "success") {
      // Needs to have some side-effect that can be observed after recovery
      return "OK";
    }
    throw new Error("Function failed!");
  }

  // DURABLY execution of flakyFunc would be some kind of wrapper which:
  //  - registers the function implementation against an operation name (so we can call it later without the function needing to still be in scope0)
  //  - registers the operation parameters and ID, marks it pending
  //  - Invokes the operation (via the registered function implementation?)
  //  - On completion, marks it complete
  //  - On wake, replays pending operations (perhaps some kind of retry budget)

  fetch(_request: Request) {
    // one handler to:
    // generate operation ID
    // execute operation (via flakyFunc) -- DURABLY

    // another handler to:
    // get operation status/result

    return new Response(greet("durable object"));
  }
}
