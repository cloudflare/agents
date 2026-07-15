import { DurableObject } from "cloudflare:workers";

import { Agent, type AgentRuntime } from "../../app/agent.js";
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

/**
 * Generic Durable Object host (ISSUE-030 W-B).
 *
 * `AgentDurableObject<A extends Agent>` is the composition-first shell: the
 * DO *has-a* Agent (built lazily, once per activation, by `createAgent`),
 * and routes platform I/O — fetch/WS upgrade, `alarm`, hibernation
 * re-attachment, and the `__init`/`__link`/`__call`/`__callResult`/
 * `__alarm`/`__destroy` RPC surface used for facet delegation — to that
 * agent and to whatever transports `transports()` composes. The base class
 * knows nothing about "chat": no `instanceof Think`, no chat-typed generic
 * bound (`A extends Agent`, not `A extends Think`). A conversation-free
 * agent (`extends Agent`, no `transports()` override) gets a fully working
 * host — WS upgrades just get a clean 400, since no transport claims them.
 *
 * What used to be `hostAgent`'s own private machinery (activation, the
 * alarm mirror, WS hibernation, RPC dispatch) now lives directly on this
 * base as real methods — not a throwing-stub class a factory installs
 * overrides onto after the fact. `hostAgent()` below is thin sugar: it
 * supplies the four seams (`createAgent`, `transports`, `onRequest`,
 * `agentClassName`) and lets this class do the actual hosting.
 *
 * Composition, explicit form (the mental model; see
 * docs/hosting-dx-sketch.md option B/C):
 *
 * ```ts
 * class SupportAgentDO extends AgentDurableObject<SupportAgent> {
 *   protected createAgent(rt: AgentRuntime) {
 *     return new SupportAgent(rt);        // the has-a seam
 *   }
 *   protected transports(agent: SupportAgent, registry: ConnectionRegistry) {
 *     return [attachChatTransport(agent, registry)];  // requires ConversationApi & co.
 *   }
 * }
 *
 * class ReminderDO extends AgentDurableObject<ReminderAgent> {
 *   protected createAgent(rt: AgentRuntime) {
 *     return new ReminderAgent(rt);       // extends Agent, no chat
 *   }
 *   // no transports() override -> WS upgrade gets 400; RPC/state/events still work.
 * }
 * ```
 *
 * `hostAgent(SupportAgent)` is the terse sugar over exactly this — one line,
 * wiring `createAgent`/`transports` for you and always composing the full
 * `cf_agent_*` chat transport (today's only transport implementation).
 */

const NAME_KEY = "cf-shell:name";
const PARENT_PATH_KEY = "cf-shell:parentPath";
const FACET_HOSTED_KEY = "cf-shell:facet-hosted";
const ALARM_REQUEST_KEY = "cf-shell:alarm-request";
const ALARM_OWN_KEY = "cf-shell:alarm-own";
const CHILD_ALARM_PREFIX = "cf-shell:child-alarm:";

const NO_EXTRA_RPC_METHODS: ReadonlySet<string> = new Set();

/**
 * Delegation RPC surface the `hostAgent` (Think) sugar allows through even
 * though these methods aren't `@callable`-decorated: a parent forwards
 * these to a child facet stub. Conversation-specific by name, but that
 * knowledge lives here, in the sugar, not in the generic base below.
 */
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

interface Activation<A extends Agent> {
  agent: A;
  registry: ConnectionRegistry;
  timer: ShellAlarmTimer;
  alarmMode: "root" | "facet";
  physical?: DurableAlarmTimer;
  armChild?: (facetKey: string, at: number | null) => void;
  rearm?: () => void;
  /** Undefined when `transports()` composed nothing (a conversation-free agent). */
  transport: ChatTransport | undefined;
}

/** Fans platform events out to every composed transport (today: 0 or 1; forward-compatible with more). */
function composeTransports(transports: ChatTransport[]): ChatTransport {
  return {
    async onConnect(conn) {
      await Promise.all(transports.map((t) => t.onConnect(conn)));
    },
    async onMessage(conn, raw) {
      await Promise.all(transports.map((t) => t.onMessage(conn, raw)));
    },
    onClose(conn) {
      for (const t of transports) t.onClose(conn);
    },
    detach() {
      for (const t of transports) t.detach();
    },
  };
}

/**
 * The composition-first generic host (ISSUE-030 W-B). `A extends Agent`
 * (never `Think`) — this class is agnostic to whether the composed agent
 * converses at all.
 */
export class AgentDurableObject<A extends Agent> extends DurableObject<unknown> {
  private activation: Promise<Activation<A>> | undefined;

  /**
   * The has-a seam: construct the agent over runtime capabilities. No
   * generic default is possible (only the author knows their agent's
   * constructor) — override it. Not TS `abstract`: `hostAgent`'s return
   * type widens its anonymous subclass to `AgentDurableObject<A>`, and
   * ported fixtures subclass that widened type purely to add RPC-forwarding
   * methods via `withAgent`, never touching this seam — an `abstract`
   * member would force them to redeclare it needlessly.
   */
  protected createAgent(_runtime: AgentRuntime, _ctx: DurableObjectState, _env: unknown): A {
    throw new Error(
      "AgentDurableObject: createAgent must be overridden (see hostAgent, or the composition example in this module's docblock)"
    );
  }

  /**
   * What this DO speaks over WebSocket, composed. Default: nothing — a
   * conversation-free agent, WS upgrades get a clean 400. Each returned
   * transport is typed by its own construction to the capability slice it
   * needs (structural, never a class check performed here).
   */
  protected transports(_agent: A, _registry: ConnectionRegistry): ChatTransport[] {
    return [];
  }

  /** Non-upgrade HTTP requests. Default: 404. */
  protected onRequest(_request: Request, _agent: A): Response | Promise<Response> {
    return new Response(null, { status: 404 });
  }

  /**
   * Identity metadata (`AgentRuntime.className`, ancestor-path entries).
   * Default: this DO subclass's own name. `hostAgent` overrides it with the
   * hosted agent class's name, matching prior behavior exactly.
   */
  protected get agentClassName(): string {
    return this.constructor.name;
  }

  /** RPC method names allowed through `__call` beyond `@callable`-registered ones. Default: none. */
  protected extraAllowedRpcMethods(): ReadonlySet<string> {
    return NO_EXTRA_RPC_METHODS;
  }

  override async fetch(request: Request): Promise<Response> {
    const activation = await this.ensure(
      request.headers.get("x-agent-name") ?? undefined
    );

    if (isWebSocketUpgrade(request)) {
      if (!activation.transport) {
        return new Response("This agent does not accept WebSocket connections", { status: 400 });
      }

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

    return await this.onRequest(request, activation.agent);
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    const activation = await this.ensure();
    if (typeof message !== "string" || !activation.transport) {
      await activation.timer.flush();
      return;
    }
    await activation.transport.onMessage(wrapSocket(ws), message);
    await activation.timer.flush();
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const activation = await this.ensure();
    activation.transport?.onClose(wrapSocket(ws));
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

  async __init(init: {
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

  async __link(_link: AlarmLink): Promise<number | null> {
    const activation = await this.ensure();
    return activation.timer.get();
  }

  async __call<T = unknown>(method: string, args: unknown[]): Promise<T> {
    return (await this.dispatchRpcCall(method, args)) as T;
  }

  async __callResult(method: string, args: unknown[]): Promise<RpcCallResult> {
    try {
      return { ok: true, result: await this.dispatchRpcCall(method, args) };
    } catch (err) {
      return { ok: false, error: toErrorValue(err) };
    }
  }

  async __alarm(): Promise<number | null> {
    const activation = await this.ensure();
    activation.timer.onPlatformAlarm();
    await activation.agent.onAlarm();
    return activation.timer.get();
  }

  async __destroy(): Promise<void> {
    const activation = await this.ensure();
    await activation.agent.destroy();
    this.activation = undefined;
  }

  protected async withAgent<T>(fn: (agent: A) => T | Promise<T>): Promise<T> {
    const activation = await this.ensure();
    return fn(activation.agent);
  }

  protected async flushAlarm(): Promise<void> {
    const activation = await this.ensure();
    await activation.timer.flush();
  }

  private async dispatchRpcCall(method: string, args: unknown[]): Promise<unknown> {
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

  private isAllowedRpcMethod(agent: A, method: string): boolean {
    if (method.startsWith("_")) return false;
    if (this.extraAllowedRpcMethods().has(method)) return true;
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

      const className = this.agentClassName;
      const selfPath = [
        ...(parentPath ?? []),
        { className, name }
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
        className,
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
          activation.transport?.detach();
          activation.timer.clear();
          await activation.timer.flush();
        },
      };

      const agent = this.createAgent(host, this.ctx, this.env);
      const registry = createDurableConnectionRegistry(this.ctx);
      const composed = this.transports(agent, registry);
      const transport =
        composed.length === 0
          ? undefined
          : composed.length === 1
            ? composed[0]
            : composeTransports(composed);
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
}

export interface HostAgentOptions<A extends Think> {
  /** Env-dependent construction (model keys etc.). Default: new AgentClass(host). */
  create?: (host: AgentRuntime, ctx: DurableObjectState, env: unknown) => A;
  /** Non-upgrade HTTP requests. Default: 404. */
  onRequest?: (request: Request, agent: A) => Response | Promise<Response>;
  /** Forwarded to attachChatTransport. */
  transport?: AttachChatTransportOptions;
}

/**
 * `hostAgent` (audit 25 §4; ISSUE-030 W-B): the terse one-line sugar for a
 * conversing (`Think`) agent, over the generic `AgentDurableObject` above.
 * Wires the has-a seam (`createAgent`) and the chat transport
 * (`attachChatTransport`, still the only transport implementation) so
 * existing call sites keep compiling unchanged:
 *
 * ```ts
 * export const SupportAgentDO = hostAgent(SupportAgent);
 * ```
 *
 * For a conversation-free agent (`extends Agent`, not `Think`), there is no
 * `hostAgent` — compose `AgentDurableObject<A>` directly (see the module
 * docblock above): the terse-sugar tier stays scoped to the conversing
 * case, per ISSUE-030.
 */
export function hostAgent<A extends Think>(
  AgentClass: new (host: AgentRuntime) => A,
  options: HostAgentOptions<A> = {}
): new (ctx: DurableObjectState, env: unknown) => AgentDurableObject<A> {
  return class extends AgentDurableObject<A> {
    protected override get agentClassName(): string {
      return AgentClass.name;
    }

    protected override createAgent(
      host: AgentRuntime,
      ctx: DurableObjectState,
      env: unknown
    ): A {
      return options.create
        ? options.create(host, ctx, env)
        : new AgentClass(host);
    }

    protected override transports(agent: A, registry: ConnectionRegistry): ChatTransport[] {
      return [attachChatTransport(agent, registry, options.transport)];
    }

    protected override onRequest(request: Request, agent: A): Response | Promise<Response> {
      return options.onRequest
        ? options.onRequest(request, agent)
        : super.onRequest(request, agent);
    }

    protected override extraAllowedRpcMethods(): ReadonlySet<string> {
      return DELEGATION_SURFACE;
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
