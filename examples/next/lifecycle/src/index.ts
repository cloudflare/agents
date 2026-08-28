import { DurableObject, RpcTarget } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import {
  Lifecycle,
  LifecycleCapability,
  type CapabilityRequestContext,
  type LifecycleJobOutcome
} from "agents/lifecycle";
import { WebSockets } from "agents/websockets";

type Activity = {
  requests: number;
  alarms: number;
};

type Wake = {
  id: string;
  startedAt: string;
};

class ActivityCapability extends LifecycleCapability {
  constructor() {
    super("activity");
  }

  onStart(): void {
    this.lifecycle.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        requests INTEGER NOT NULL,
        alarms INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO activity (id, requests, alarms) VALUES (1, 0, 0);
    `);
  }

  onRequest({ request }: CapabilityRequestContext): Response | undefined {
    if (new URL(request.url).pathname.endsWith("/stats")) {
      return Response.json(this.getActivity());
    }

    this.lifecycle.storage.sql.exec(`
      UPDATE activity SET requests = requests + 1 WHERE id = 1
    `);
  }

  /** Push a job into the Lifecycle queue; onJob runs when it comes due. */
  async recordActivitySoon(): Promise<void> {
    await this.lifecycle.jobs.push({
      id: "activity-tick",
      fn: "tick",
      time: Date.now() + 5_000
    });
  }

  onJob(): LifecycleJobOutcome {
    this.lifecycle.storage.sql.exec(`
      UPDATE activity SET alarms = alarms + 1 WHERE id = 1
    `);
    // Returning nothing would complete the job; this one-shot completes.
    return undefined;
  }

  getActivity(): Activity {
    const rows = [
      ...this.lifecycle.storage.sql.exec<Activity>(
        "SELECT requests, alarms FROM activity WHERE id = 1"
      )
    ];
    return rows[0] ?? { requests: 0, alarms: 0 };
  }
}

/**
 * Remote methods served over the Cap'n Web callables endpoint
 * (`?__agents_rpc=capnweb`). The target's prototype methods are the
 * complete remote interface.
 */
class ActivityCallables extends RpcTarget {
  constructor(private readonly host: DoAgent) {
    super();
  }

  activity(): Promise<Activity> {
    return this.host.getActivity();
  }
}

/** A plain Durable Object composed with the Agents lifecycle. */
export class DoAgent extends DurableObject<Env> {
  private readonly activity = new ActivityCapability();
  private wake: Wake | undefined;

  // WebSockets are opt-in: Lifecycle itself does not model connections.
  // The capability owns upgrades, hibernating sockets, handler
  // dispatch, and the Cap'n Web callables endpoint.
  private readonly webSockets = new WebSockets({
    callables: new ActivityCallables(this),
    handlers: {
      onConnect: (connection) => {
        connection.send(
          JSON.stringify({
            type: "connected",
            name: this.lifecycle.name,
            wake: this.wake,
            activity: this.activity.getActivity()
          })
        );
      },
      onMessage: (connection, message) => {
        connection.send(`echo:${String(message)}`);
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.activity)
    .use(this.webSockets);

  onStart(): void {
    this.wake = {
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString()
    };
    console.log("started", this.lifecycle.name, this.wake);
  }

  async onRequest(): Promise<Response> {
    await this.activity.recordActivitySoon();
    return Response.json({
      name: this.lifecycle.name,
      message: "Hello from a plain Durable Object",
      wake: this.wake,
      activity: this.activity.getActivity()
    });
  }

  onAlarm(): void {
    console.log("alarm", this.lifecycle.name, this.activity.getActivity());
  }

  async getActivity(): Promise<Activity> {
    await this.lifecycle.start();
    return this.activity.getActivity();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
