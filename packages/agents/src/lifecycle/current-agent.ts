import { AsyncLocalStorage } from "node:async_hooks";
import type { DurableObject } from "cloudflare:workers";

import type { MemoryLimitContext } from "./capability-runner";
import type { Lifecycle } from "./durable-object-lifecycle";
import type { Connection } from "./types";
import type { LifecycleJobContext, LifecycleJobOutcome } from "./job-queue";

/**
 * A Durable Object that has installed the Agents SDK Lifecycle.
 *
 * Pass a more specific Lifecycle Object type to {@link getCurrentAgent} when
 * shared host code needs APIs implemented by a particular object.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface LifecycleObject<
  Env extends object = Cloudflare.Env,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends DurableObject<Env> {
  readonly lifecycle: Lifecycle<Env, Props>;
  onStart?(props?: Props): void | Promise<void>;
  onRequest?(request: Request): Response | Promise<Response>;
  onAlarm?(): void | Promise<void>;
  onJob?(
    context: LifecycleJobContext
  ): LifecycleJobOutcome | void | Promise<LifecycleJobOutcome | void>;
  /**
   * Host domain policy applied when the alarm memory-limit circuit breaker
   * records a strike (#1825), after every capability's `onMemoryLimit` hook.
   *
   * Lifecycle dispatches host hooks structurally through its internal host
   * cast, so TS visibility is the host's to choose: a framework host whose
   * implementation is internal machinery declares the hook `protected` (the
   * pattern — see `AIChatAgent`/`Think`) and keeps the real work in a
   * `private _cf_`-prefixed method, without falling out of this contract at
   * runtime.
   */
  onAlarmMemoryLimit?(context: MemoryLimitContext): void | Promise<void>;
}

/**
 * Caller-supplied hints carried on a contextual RPC call. JSON scalars only,
 * so the record survives the wire unchanged.
 */
export type RpcCallContext = Readonly<
  Record<string, string | number | boolean>
>;

/** How a Lifecycle host identifies itself to the objects it calls. */
export type AgentCallerIdentity = {
  /** Exported class name of the calling host. */
  readonly className: string;
  /** Durable Object id of the calling host, as a string. */
  readonly sessionId: string;
  /** Instance name of the calling host, when it has one. */
  readonly sessionName: string | undefined;
};

/**
 * Who made the contextual RPC call now being handled.
 *
 * Untrusted metadata: suitable for correlation and tracing, never for
 * identity, tenancy, or authorization decisions. Derive those from data the
 * callee authenticates itself.
 */
export type AgentCaller =
  | ({
      readonly kind: "agent";
      readonly context: RpcCallContext;
    } & AgentCallerIdentity)
  | { readonly kind: "external"; readonly context: RpcCallContext };

/** Values associated with the currently executing Lifecycle host. */
export type AgentContextStore = {
  /** Lifecycle host selected for this invocation. */
  agent: unknown;
  /** WebSocket connection selected for this invocation, when applicable. */
  connection: Connection | undefined;
  /** HTTP request selected for this invocation, when applicable. */
  request: Request | undefined;
  /** Extension-owned value selected for this invocation, when applicable. */
  email: unknown;
  /** Caller of the contextual RPC call being handled, when applicable. */
  caller?: AgentCaller;
};

/** Values returned by {@link getCurrentAgent}. */
export type CurrentAgentContext<
  Host extends DurableObject = LifecycleObject,
  Email = unknown
> = {
  agent: Host | undefined;
  connection: Connection | undefined;
  request: Request | undefined;
  email: Email | undefined;
  /**
   * The caller of the contextual RPC call being handled, or `undefined` for
   * every other entry point (fetch, alarms, native RPC on an unwrapped stub).
   */
  caller: AgentCaller | undefined;
};

/**
 * Shared invocation context for Lifecycle, Agent, AIChatAgent, and Think.
 *
 * @internal Importing or relying on this symbol will break your code in a
 * future release. Use {@link getCurrentAgent} to read the public context.
 */
export const __DO_NOT_USE_WILL_BREAK__agentContext =
  new AsyncLocalStorage<AgentContextStore>();

/**
 * Return the current Agent or Lifecycle Object and invocation-specific values.
 *
 * Lifecycle host startup and alarm hooks receive the current object with no
 * request. Request hooks additionally receive the request being handled.
 * Lifecycle-managed WebSocket hooks receive their connection and, during
 * connect, its upgrade request. Agent extensions may also establish context
 * for email, chat turns, callable methods, and detached work. Capability hooks
 * do not run in this ambient context.
 */
export function getCurrentAgent<
  Host extends DurableObject = LifecycleObject
>(): CurrentAgentContext<Host> {
  const store = __DO_NOT_USE_WILL_BREAK__agentContext.getStore();
  if (!store) {
    return {
      agent: undefined,
      connection: undefined,
      request: undefined,
      email: undefined,
      caller: undefined
    };
  }

  return {
    agent: store.agent as Host,
    connection: store.connection,
    request: store.request,
    email: store.email,
    caller: store.caller
  };
}

type LifecycleHostContext<
  Env extends object,
  Props extends Record<string, unknown>
> = {
  readonly host: LifecycleObject<Env, Props>;
  readonly connection?: Connection;
  readonly request?: Request;
};

/** Run one host hook in the context of its Lifecycle Object. */
export function runInLifecycleHostContext<
  Env extends object,
  Props extends Record<string, unknown>,
  T
>(context: LifecycleHostContext<Env, Props>, operation: () => T): T {
  return __DO_NOT_USE_WILL_BREAK__agentContext.run(
    {
      agent: context.host,
      connection: context.connection,
      request: context.request,
      email: undefined
    },
    operation
  );
}

/** Run a capability hook without inheriting a current Agent or host context. */
export function runWithoutCurrentAgent<T>(operation: () => T): T {
  return __DO_NOT_USE_WILL_BREAK__agentContext.exit(operation);
}
