import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import {
  Lifecycle,
  type CapabilityRequestContext,
  type Connection,
  type DurableObjectCapability,
  type WSMessage
} from "agents/lifecycle";

type Activity = {
  requests: number;
  alarms: number;
};

type Wake = {
  id: string;
  startedAt: string;
};

class ActivityCapability implements DurableObjectCapability {
  constructor(private readonly storage: DurableObjectStorage) {}

  onStart(): void {
    this.storage.sql.exec(`
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

    this.storage.sql.exec(`
      UPDATE activity SET requests = requests + 1 WHERE id = 1
    `);
  }

  onAlarm(): void {
    this.storage.sql.exec(`
      UPDATE activity SET alarms = alarms + 1 WHERE id = 1
    `);
  }

  getActivity(): Activity {
    const rows = [
      ...this.storage.sql.exec<Activity>(
        "SELECT requests, alarms FROM activity WHERE id = 1"
      )
    ];
    return rows[0] ?? { requests: 0, alarms: 0 };
  }
}

/** A composable Agent built from DurableObject and Lifecycle. */
export class DoAgent extends DurableObject<Env> {
  private readonly activity = new ActivityCapability(this.ctx.storage);
  private wake: Wake | undefined;
  readonly lifecycle = Lifecycle.install(this).use(this.activity);

  onStart(): void {
    this.wake = {
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString()
    };
    console.log("started", this.lifecycle.name, this.wake);
  }

  async onRequest(): Promise<Response> {
    await this.ctx.storage.setAlarm(Date.now() + 5_000);
    return Response.json({
      name: this.lifecycle.name,
      message: "Hello from a composable Agent",
      wake: this.wake,
      activity: this.activity.getActivity()
    });
  }

  onAlarm(): void {
    console.log("alarm", this.lifecycle.name, this.activity.getActivity());
  }

  onConnect(connection: Connection): void {
    connection.send(
      JSON.stringify({
        type: "connected",
        name: this.lifecycle.name,
        wake: this.wake,
        activity: this.activity.getActivity()
      })
    );
  }

  onMessage(connection: Connection, message: WSMessage): void {
    connection.send(`echo:${String(message)}`);
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
