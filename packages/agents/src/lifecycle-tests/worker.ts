import { DurableObject } from "cloudflare:workers";
import {
  Lifecycle,
  routeDurableObjectRequest,
  type Connection,
  type DurableObjectCapability,
  type WSMessage
} from "../lifecycle";

export type Env = {
  PlainLifecycleObject: DurableObjectNamespace<PlainLifecycleObject>;
};

type StartupProps = { label: string };

export class PlainLifecycleObject extends DurableObject<Env> {
  readonly #events: string[] = [];

  readonly lifecycle = Lifecycle.install<Env, StartupProps>(this).use({
    onStart: ({ props }) => {
      this.#events.push(`capability:start:${props?.label ?? "none"}`);
    },
    onRequest: ({ request }) => {
      this.#events.push("capability:request");
      if (new URL(request.url).searchParams.has("capability")) {
        return Response.json(this.#events);
      }
    },
    onAlarm: () => {
      this.#events.push("capability:alarm");
    }
  } satisfies DurableObjectCapability<StartupProps>);

  onStart(props?: StartupProps): void {
    this.#events.push(`host:start:${props?.label ?? "none"}`);
  }

  onRequest(request: Request): Response {
    this.#events.push("host:request");
    return Response.json({
      name: this.lifecycle.name,
      events: this.#events,
      hasInternalPropsHeader: request.headers.has("x-agents-lifecycle-props")
    });
  }

  onAlarm(): void {
    this.#events.push("host:alarm");
  }

  onConnect(connection: Connection): void {
    connection.send(`connected:${this.lifecycle.name}`);
  }

  onMessage(connection: Connection, message: WSMessage): void {
    connection.send(`echo:${String(message)}`);
  }

  installHandlersAgainForTest(): string {
    try {
      this.lifecycle.installHandlers();
      return "installed";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async seedLegacyNameForTest(name: string): Promise<void> {
    await this.ctx.storage.put("__ps_name", name);
  }

  async scheduleAlarm(): Promise<void> {
    await this.lifecycle.start();
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async getEvents(): Promise<readonly string[]> {
    await this.lifecycle.start();
    return this.#events;
  }

  async startFromRpc(props: StartupProps): Promise<readonly string[]> {
    await this.lifecycle.start(props);
    return this.#events;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeDurableObjectRequest(request, env, {
        prefix: "objects",
        props: { label: "routed" }
      })) ?? new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
