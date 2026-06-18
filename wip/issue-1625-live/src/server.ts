/**
 * Live #1625 teardown repro worker.
 *
 * A real `McpAgent` (Streamable-HTTP) deployed to Cloudflare so we can exercise
 * the *production* failure mode #1625 surfaced: the session-DELETE handler used
 * to run `agent.destroy()` on the front Worker's `ctx.waitUntil`, and by the
 * time a DELETE lands the client has usually disconnected — so the runtime gave
 * that trailing task little to no grace and cancelled the multi-step teardown
 * mid-flight, leaving a half-deleted "zombie" session DO whose tables the
 * constructor silently recreated on the next wake. The local
 * `vitest-pool-workers` runtime does NOT cancel `waitUntil`, which is exactly
 * why the bug only bit in production and the unit tests cannot reproduce it.
 *
 * The fix (this PR) defers teardown to the agent's own alarm invocation behind a
 * durable "condemned" marker. This worker + the `scripts/repro.ts` orchestrator
 * verify, against a real deployment, that a DELETE (optionally with a
 * client-side abort to mimic the disconnected client) reliably converges to a
 * fully-wiped session DO.
 *
 * Zombie detection: we seed the session DO's `state.counter` to a sentinel
 * value before DELETE. A clean teardown wipes all storage, so re-addressing the
 * session afterwards constructs a FRESH DO whose counter is back to
 * `initialState` (1). A zombie keeps the sentinel — the constructor's
 * `CREATE TABLE IF NOT EXISTS` does not overwrite the surviving `state` row.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { getAgentByName } from "agents";
import { z } from "zod";

type Env = {
  MCP_TEARDOWN: DurableObjectNamespace<McpTeardownAgent>;
};

type State = { counter: number };

// Mirrors the SDK-internal marker key so the probe can observe an in-flight
// (or stuck) teardown directly. Kept in sync with `DESTROY_PENDING_KEY` in
// packages/agents/src/index.ts.
const DESTROY_PENDING_KEY = "cf_agents_destroy_pending";

export type TeardownProbe = {
  counter: number;
  markerPresent: boolean;
  hasAlarm: boolean;
  initialized: boolean;
};

export class McpTeardownAgent extends McpAgent<
  Env,
  State,
  Record<string, never>
> {
  server = new McpServer({
    name: "TeardownProbe",
    version: "1.0.0"
  });

  initialState: State = { counter: 1 };

  async init() {
    this.server.registerTool(
      "bump",
      {
        description: "Increment the counter",
        inputSchema: { by: z.number() }
      },
      async ({ by }) => {
        this.setState({ counter: this.state.counter + by });
        return {
          content: [{ type: "text", text: String(this.state.counter) }]
        };
      }
    );
  }

  /**
   * Test-only: seed a sentinel counter so a later probe can tell a clean wipe
   * (counter resets to initialState) apart from a zombie (counter survives).
   * Not part of the SDK surface — lives here purely for the repro harness.
   */
  async seedForTest(counter: number): Promise<State> {
    this.setState({ counter });
    return this.state;
  }

  /**
   * Test-only: report the signals that distinguish "fully torn down" from
   * "zombie / mid-teardown". `markerPresent` is the durable condemned flag;
   * `initialized` is the MCP session record the DELETE handler keys on.
   */
  async probeForTest(): Promise<TeardownProbe> {
    const marker = await this.ctx.storage.get<boolean>(DESTROY_PENDING_KEY);
    const alarm = await this.ctx.storage.getAlarm();
    const init = await this.getInitializeRequest();
    return {
      counter: this.state.counter,
      markerPresent: marker === true,
      hasAlarm: alarm !== null,
      initialized: Boolean(init)
    };
  }

  override async alarm() {
    // Instrumentation: surface the deferred-teardown landing in `wrangler tail`.
    const marker = await this.ctx.storage.get<boolean>(DESTROY_PENDING_KEY);
    if (marker === true) {
      console.log(
        `[1625] alarm: pending destroy -> running teardown (${this.name})`
      );
    }
    await super.alarm();
  }
}

const mcpHandler = McpTeardownAgent.serve("/mcp", { binding: "MCP_TEARDOWN" });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/introspect") {
      const session = url.searchParams.get("session");
      if (!session) {
        return Response.json(
          { error: "session query param required" },
          {
            status: 400
          }
        );
      }
      const action = url.searchParams.get("action") ?? "probe";
      const agent = await getAgentByName(
        env.MCP_TEARDOWN,
        `streamable-http:${session}`
      );
      if (action === "seed") {
        const counter = Number(url.searchParams.get("counter") ?? "5");
        console.log(`[1625] seed session=${session} counter=${counter}`);
        return Response.json(await agent.seedForTest(counter));
      }
      const probe = await agent.probeForTest();
      console.log(`[1625] probe session=${session} ${JSON.stringify(probe)}`);
      return Response.json(probe);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("issue-1625-live: ok\n", { status: 200 });
    }

    if (request.method === "DELETE") {
      console.log(
        `[1625] DELETE session=${request.headers.get("mcp-session-id")}`
      );
    }

    return mcpHandler.fetch(request, env, ctx);
  }
};
