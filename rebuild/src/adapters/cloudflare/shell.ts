import { DurableObject } from "cloudflare:workers";

import type { AgentRuntime } from "../../app/agent.js";
import type { Think } from "../../app/think.js";
import { NotFoundError, toErrorValue, type ErrorValue } from "../../kernel/errors.js";
import type { AlarmTimer } from "../../ports/alarms.js";
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
import { createFacetSpawner } from "./spawner.js";
import { createDurableKeyValueStore } from "./store.js";
import type { ConnectionRegistry } from "../../ports/transport.js";

const NAME_KEY = "cf-shell:name";
const PARENT_PATH_KEY = "cf-shell:parentPath";
const FACET_HOSTED_KEY = "cf-shell:facet-hosted";
const ALARM_REQUEST_KEY = "cf-shell:alarm-request";
const ALARM_OWN_KEY = "cf-shell:alarm-own";
const CHILD_ALARM_PREFIX = "cf-shell:child-alarm:";

const DELEGATION_SURFACE = new Set(["chat", "cancelChat", "inspectRun"]);

type ParentPath = NonNullable<AgentRuntime["parentPath"]>;
type AlarmLink = { armChild: (at: number | null) => void };
type RpcCallResult =
  | { ok: true; result: unknown }
  | { ok: false; error: ErrorValue };

interface ShellAlarmTimer extends AlarmTimer {
  flush(): Promise<void>;
  onPlatformAlarm(): number | null;
}

interface Activation<A extends Think> {
  agent: A;
  registry: ConnectionRegistry;
  timer: ShellAlarmTimer;
  alarmMode: "root" | "facet";
  physical?: DurableAlarmTimer;
  armChild?: (facetKey: string, at: number | null) => void;
  rearm?: () => void;
  transport: ChatTransport;
}

export interface HostAgentOptions<A extends Think> {
  /** Env-dependent construction (model keys etc.). Default: new AgentClass(host). */
  create?: (host: AgentRuntime, ctx: DurableObjectState, env: unknown) => A;
  /** Non-upgrade HTTP requests. Default: 404. */
  onRequest?: (request: Request, agent: A) => Response | Promise<Response>;
  /** Forwarded to attachChatTransport. */
  transport?: AttachChatTransportOptions;
}

export class HostedAgentDurableObject<A extends Think> extends DurableObject<unknown> {
  __init(_init: {
    name: string;
    parentPath?: AgentRuntime["parentPath"];
    facetHosted?: boolean;
  }): Promise<void> {
    throw new Error("hostAgent did not install __init");
  }

  __link(_link: AlarmLink): Promise<number | null> {
    throw new Error("hostAgent did not install __link");
  }

  __call<T = unknown>(_method: string, _args: unknown[]): Promise<T> {
    throw new Error("hostAgent did not install __call");
  }

  __callResult(_method: string, _args: unknown[]): Promise<RpcCallResult> {
    throw new Error("hostAgent did not install __callResult");
  }

  __alarm(): Promise<number | null> {
    throw new Error("hostAgent did not install __alarm");
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
  AgentClass: new (host: AgentRuntime) => A,
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
      if (activation.alarmMode === "facet") {
        activation.timer.onPlatformAlarm();
        await activation.agent.onAlarm();
      } else {
        await this.dispatchRootAlarm(activation);
      }
      await activation.timer.flush();
    }

    override async __init(init: {
      name: string;
      parentPath?: AgentRuntime["parentPath"];
      facetHosted?: boolean;
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
      if (init.facetHosted === true) {
        store.put(FACET_HOSTED_KEY, true);
      }
    }

    override async __link(_link: AlarmLink): Promise<number | null> {
      const activation = await this.ensure();
      return activation.timer.get();
    }

    override async __call<T = unknown>(
      method: string,
      args: unknown[]
    ): Promise<T> {
      return (await this.dispatchRpcCall(method, args)) as T;
    }

    override async __callResult(
      method: string,
      args: unknown[]
    ): Promise<RpcCallResult> {
      try {
        return { ok: true, result: await this.dispatchRpcCall(method, args) };
      } catch (err) {
        return { ok: false, error: toErrorValue(err) };
      }
    }

    private async dispatchRpcCall(
      method: string,
      args: unknown[]
    ): Promise<unknown> {
      const activation = await this.ensure();
      if (!this.isAllowedRpcMethod(activation.agent, method)) {
        throw new NotFoundError(`Unknown method ${method}`);
      }
      const fn = (activation.agent as unknown as Record<string, unknown>)[method];
      if (typeof fn !== "function") {
        throw new NotFoundError(`Unknown method ${method}`);
      }
      const tracked = this.trackRpcCallbacks(args);
      const result = await fn.apply(activation.agent, tracked.args);
      await tracked.drain();
      return result;
    }

    override async __alarm(): Promise<number | null> {
      const activation = await this.ensure();
      activation.timer.onPlatformAlarm();
      await activation.agent.onAlarm();
      return activation.timer.get();
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

    private isAllowedRpcMethod(agent: A, method: string): boolean {
      if (method.startsWith("_")) return false;
      if (DELEGATION_SURFACE.has(method)) return true;
      return agent.callables().callableMethods().has(method);
    }

    private trackRpcCallbacks(args: unknown[]): {
      args: unknown[];
      drain: () => Promise<void>;
    } {
      const pending = new Set<Promise<unknown>>();

      const wrap = (value: unknown): unknown => {
        if (typeof value === "function") {
          return (...fnArgs: unknown[]): unknown => {
            const result = value(...fnArgs);
            const pendingResult = Promise.resolve(result);
            pending.add(pendingResult);
            pendingResult.then(
              () => pending.delete(pendingResult),
              () => pending.delete(pendingResult)
            );
            return result;
          };
        }
        if (Array.isArray(value)) return value.map(wrap);
        if (value === null || typeof value !== "object") return value;
        const wrapped: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
          wrapped[key] = wrap(entry);
        }
        return wrapped;
      };

      return {
        args: args.map(wrap),
        async drain(): Promise<void> {
          while (pending.size > 0) {
            await Promise.allSettled([...pending]);
          }
        }
      };
    }

    private createFacetAlarmTimer(
      store: ReturnType<typeof createDurableKeyValueStore>
    ): ShellAlarmTimer {
      let alarmAt = store.get<number>(ALARM_REQUEST_KEY) ?? null;

      return {
        set: (at: number): void => {
          alarmAt = at;
          store.put(ALARM_REQUEST_KEY, at);
        },
        get: (): number | null => alarmAt,
        clear: (): void => {
          alarmAt = null;
          store.delete(ALARM_REQUEST_KEY);
        },
        flush: () => Promise.resolve(),
        onPlatformAlarm: (): number | null => {
          const firedAt = alarmAt;
          alarmAt = null;
          store.delete(ALARM_REQUEST_KEY);
          return firedAt;
        }
      };
    }

    private createRootAlarmTimer(
      store: ReturnType<typeof createDurableKeyValueStore>,
      physical: DurableAlarmTimer
    ): ShellAlarmTimer {
      let ownAt = store.get<number>(ALARM_OWN_KEY) ?? null;

      const rearm = (): void => {
        const next = this.nextRootAlarm(store);
        if (next === null) {
          physical.clear();
        } else {
          physical.set(next);
        }
      };

      return {
        set(at: number): void {
          ownAt = at;
          store.put(ALARM_OWN_KEY, at);
          rearm();
        },
        get(): number | null {
          return ownAt;
        },
        clear(): void {
          ownAt = null;
          store.delete(ALARM_OWN_KEY);
          rearm();
        },
        flush(): Promise<void> {
          return physical.flush();
        },
        onPlatformAlarm(): number | null {
          const firedAt = ownAt;
          ownAt = null;
          store.delete(ALARM_OWN_KEY);
          return firedAt;
        }
      };
    }

    private nextRootAlarm(
      store: ReturnType<typeof createDurableKeyValueStore>
    ): number | null {
      let next = store.get<number>(ALARM_OWN_KEY) ?? null;
      for (const at of store.list<number>({ prefix: CHILD_ALARM_PREFIX }).values()) {
        if (next === null || at < next) next = at;
      }
      return next;
    }

    private async dispatchRootAlarm(activation: Activation<A>): Promise<void> {
      const store = createDurableKeyValueStore(this.ctx.storage);
      const firedAt = activation.physical?.onPlatformAlarm() ?? Date.now();
      const dueAt = Math.max(Date.now(), firedAt);
      const ownAt = store.get<number>(ALARM_OWN_KEY);

      if (ownAt !== undefined && ownAt <= dueAt) {
        activation.timer.onPlatformAlarm();
        await activation.agent.onAlarm();
      }

      const dueChildren = [...store.list<number>({ prefix: CHILD_ALARM_PREFIX })]
        .filter(([, at]) => at <= dueAt)
        .sort(([leftKey, leftAt], [rightKey, rightAt]) =>
          leftAt === rightAt
            ? leftKey.localeCompare(rightKey)
            : leftAt - rightAt
        );

      for (const [rowKey] of dueChildren) {
        const facetKey = rowKey.slice(CHILD_ALARM_PREFIX.length);
        const stub = this.childAlarmStub(facetKey);
        const next = await stub.__alarm();
        if (next === null) {
          store.delete(rowKey);
        } else {
          store.put(rowKey, next);
        }
      }

      activation.rearm?.();
    }

    private childAlarmStub(facetKey: string): DurableObjectStub & {
      __link(link: AlarmLink): Promise<number | null>;
      __alarm(): Promise<number | null>;
    } {
      const separator = facetKey.indexOf("\0");
      const className = separator === -1
        ? facetKey
        : facetKey.slice(0, separator);
      const Ctor = this.ctx.exports[className];
      if (Ctor === undefined) {
        throw new NotFoundError(`Unknown agent class: ${className}`);
      }
      return this.ctx.facets.get(facetKey, () => ({
        class: Ctor
      })) as DurableObjectStub & {
        __link(link: AlarmLink): Promise<number | null>;
        __alarm(): Promise<number | null>;
      };
    }

    private ensure(nameHint?: string): Promise<Activation<A>> {
      this.activation ??= this.ctx.blockConcurrencyWhile(async () => {
        const initial = await this.ctx.storage.getAlarm();
        const physical = createDurableAlarmTimer({
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
        const facetHosted = store.get<boolean>(FACET_HOSTED_KEY) === true;
        const timer = facetHosted
          ? this.createFacetAlarmTimer(store)
          : this.createRootAlarmTimer(store, physical);
        let activation: Activation<A> | undefined;

        const selfPath = [
          ...(parentPath ?? []),
          { className: AgentClass.name, name }
        ];
        const armChild = (facetKey: string, at: number | null): void => {
          if (at === null) {
            store.delete(CHILD_ALARM_PREFIX + facetKey);
          } else {
            store.put(CHILD_ALARM_PREFIX + facetKey, at);
          }
          activation?.rearm?.();
        };

        const host: AgentRuntime = {
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
          ...(!facetHosted
            ? {
                spawner: createFacetSpawner({
                  ctx: this.ctx,
                  selfPath,
                  arm: armChild
                })
              }
            : {}),
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
        activation = {
          agent,
          registry,
          timer,
          alarmMode: facetHosted ? "facet" : "root",
          ...(facetHosted ? {} : { physical, armChild }),
          transport
        };
        if (!facetHosted) {
          activation.rearm = () => {
            const next = this.nextRootAlarm(store);
            if (next === null) {
              physical.clear();
            } else {
              physical.set(next);
            }
          };
        }
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
