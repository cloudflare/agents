import { DurableObject } from "cloudflare:workers";

import type { AgentHost } from "../../app/agent.js";
import type { Think } from "../../app/think.js";
import {
  attachChatTransport,
  type AttachChatTransportOptions,
  type ChatTransport,
} from "../websocket-chat/adapter.js";
import {
  createDurableAlarmTimer,
  type DurableAlarmTimer,
} from "./alarm.js";
import {
  createDurableConnectionRegistry,
  wrapSocket,
} from "./connection.js";
import { createDurableKeyValueStore } from "./store.js";
import type { ConnectionRegistry } from "../../ports/transport.js";

const NAME_KEY = "cf-shell:name";
const PARENT_PATH_KEY = "cf-shell:parentPath";

type ParentPath = NonNullable<AgentHost["parentPath"]>;

interface Activation<A extends Think> {
  agent: A;
  registry: ConnectionRegistry;
  timer: DurableAlarmTimer;
  transport: ChatTransport;
}

export interface HostAgentOptions<A extends Think> {
  /** Env-dependent construction (model keys etc.). Default: new AgentClass(host). */
  create?: (host: AgentHost, ctx: DurableObjectState, env: unknown) => A;
  /** Non-upgrade HTTP requests. Default: 404. */
  onRequest?: (request: Request, agent: A) => Response | Promise<Response>;
  /** Forwarded to attachChatTransport. */
  transport?: AttachChatTransportOptions;
}

export class HostedAgentDurableObject<A extends Think> extends DurableObject<unknown> {
  __init(_init: {
    name: string;
    parentPath?: AgentHost["parentPath"];
  }): Promise<void> {
    throw new Error("hostAgent did not install __init");
  }

  __destroy(): Promise<void> {
    throw new Error("hostAgent did not install __destroy");
  }

  protected withAgent<T>(
    _fn: (agent: A) => T | Promise<T>
  ): Promise<T>;
  protected withAgent<T>(
    _fn: (agent: A) => T | Promise<T>
  ): Promise<T> {
    throw new Error("hostAgent did not install withAgent");
  }

  protected flushAlarm(): Promise<void> {
    throw new Error("hostAgent did not install flushAlarm");
  }
}

/**
 * Durable Object hosting shell for Think agents.
 *
 * Shell-owned storage rows use the reserved `cf-shell:` prefix in the same
 * durable key-value store as the domain modules. No domain module writes this
 * prefix; it carries identity metadata that workerd does not expose via
 * `ctx.id.name`.
 */
export function hostAgent<A extends Think>(
  AgentClass: new (host: AgentHost) => A,
  options: HostAgentOptions<A> = {}
): new (ctx: DurableObjectState, env: unknown) => HostedAgentDurableObject<A> {
  return class HostedAgentDO extends HostedAgentDurableObject<A> {
    private activation: Promise<Activation<A>> | undefined;

    constructor(ctx: DurableObjectState, env: unknown) {
      super(ctx, env);
    }

    override async fetch(request: Request): Promise<Response> {
      const activation = await this.ensure(
        request.headers.get("x-agent-name") ?? undefined
      );

      if (isWebSocketUpgrade(request)) {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        const url = new URL(request.url);
        const id = url.searchParams.get("_pk") ?? crypto.randomUUID();

        this.ctx.acceptWebSocket(server, [id]);
        server.serializeAttachment({ id, state: {} });

        await activation.transport.onConnect(wrapSocket(server));
        await activation.timer.flush();

        return new Response(null, { status: 101, webSocket: client });
      }

      return (
        (await options.onRequest?.(request, activation.agent)) ??
        new Response(null, { status: 404 })
      );
    }

    override async webSocketMessage(
      ws: WebSocket,
      message: string | ArrayBuffer
    ): Promise<void> {
      const activation = await this.ensure();
      if (typeof message !== "string") {
        await activation.timer.flush();
        return;
      }
      await activation.transport.onMessage(wrapSocket(ws), message);
      await activation.timer.flush();
    }

    override async webSocketClose(ws: WebSocket): Promise<void> {
      const activation = await this.ensure();
      activation.transport.onClose(wrapSocket(ws));
    }

    override async alarm(): Promise<void> {
      const activation = await this.ensure();
      activation.timer.onPlatformAlarm();
      await activation.agent.onAlarm();
      await activation.timer.flush();
    }

    override async __init(init: {
      name: string;
      parentPath?: AgentHost["parentPath"];
    }): Promise<void> {
      const store = createDurableKeyValueStore(this.ctx.storage);
      const existing = store.get<string>(NAME_KEY);
      if (existing !== undefined && existing !== init.name) {
        throw new Error(
          `Agent already initialized as "${existing}", cannot initialize as "${init.name}"`
        );
      }

      const active = this.activation ? await this.activation : undefined;
      if (
        active &&
        existing === undefined &&
        active.agent.name !== init.name
      ) {
        throw new Error(
          `Agent already started as "${active.agent.name}", cannot initialize as "${init.name}"`
        );
      }

      if (existing === undefined) store.put(NAME_KEY, init.name);
      if (
        init.parentPath !== undefined &&
        store.get<ParentPath>(PARENT_PATH_KEY) === undefined
      ) {
        store.put(PARENT_PATH_KEY, init.parentPath);
      }
    }

    override async __destroy(): Promise<void> {
      const activation = await this.ensure();
      await activation.agent.destroy();
      this.activation = undefined;
    }

    protected override async withAgent<T>(
      fn: (agent: A) => T | Promise<T>
    ): Promise<T> {
      const activation = await this.ensure();
      return fn(activation.agent);
    }

    protected override async flushAlarm(): Promise<void> {
      const activation = await this.ensure();
      await activation.timer.flush();
    }

    private ensure(nameHint?: string): Promise<Activation<A>> {
      this.activation ??= this.ctx.blockConcurrencyWhile(async () => {
        const initial = await this.ctx.storage.getAlarm();
        const timer = createDurableAlarmTimer({
          storage: this.ctx.storage,
          initial,
        });
        const store = createDurableKeyValueStore(this.ctx.storage);
        const existingName = store.get<string>(NAME_KEY);
        const name = existingName ?? nameHint ?? this.ctx.id.toString();
        if (existingName === undefined && nameHint !== undefined) {
          store.put(NAME_KEY, nameHint);
        }
        const parentPath = store.get<ParentPath>(PARENT_PATH_KEY);
        let activation: Activation<A> | undefined;

        const host: AgentHost = {
          className: AgentClass.name,
          name,
          store,
          alarm: timer,
          clock: { now: () => Date.now() },
          ids: {
            newId: (prefix) =>
              `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`,
          },
          ...(parentPath !== undefined ? { parentPath } : {}),
          onDestroyed: async () => {
            if (!activation) return;
            for (const conn of activation.registry.connections()) {
              try {
                conn.close(1001);
              } catch {
                // Ignore close races during teardown.
              }
            }
            activation.transport.detach();
            activation.timer.clear();
            await activation.timer.flush();
          },
        };

        const agent = options.create
          ? options.create(host, this.ctx, this.env)
          : new AgentClass(host);
        const registry = createDurableConnectionRegistry(this.ctx);
        const transport = attachChatTransport(
          agent,
          registry,
          options.transport
        );
        activation = { agent, registry, timer, transport };
        await agent.start();
        return activation;
      });

      return this.activation;
    }
  };
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers
    .get("Upgrade")
    ?.toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .includes("websocket") ?? false;
}
