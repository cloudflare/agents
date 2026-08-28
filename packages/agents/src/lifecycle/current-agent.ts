import { AsyncLocalStorage } from "node:async_hooks";
import type { DurableObject } from "cloudflare:workers";

import type { Lifecycle } from "./durable-object-lifecycle";
import type { Connection } from "./types";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "./job-queue";

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
  onJobError?(
    context: LifecycleJobContext,
    error: unknown
  ): LifecycleJobOutcome | void | Promise<LifecycleJobOutcome | void>;
  onAlarmMemoryLimit?(context: {
    readonly sealed: boolean;
    readonly nextTime?: number;
  }): void | Promise<void>;
}

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
      email: undefined
    };
  }

  return {
    agent: store.agent as Host,
    connection: store.connection,
    request: store.request,
    email: store.email
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
