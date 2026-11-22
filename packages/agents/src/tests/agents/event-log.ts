import { Agent } from "../../index.ts";

/**
 * An Agent that declares an event log, for checking that a connection
 * routed to one of its sub-agents cannot follow (and read) it.
 */
export class TestEventLogParent extends Agent<Cloudflare.Env> {
  readonly feed = this._declareEventLog<string, string[]>("feed", {
    snapshot: () => ["parent only"]
  });
}
