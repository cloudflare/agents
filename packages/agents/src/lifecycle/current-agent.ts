import { AsyncLocalStorage } from "node:async_hooks";
import type { DurableObject } from "cloudflare:workers";

import type { Lifecycle, WSMessage } from "./durable-object-lifecycle";
import type { Connection, ConnectionContext } from "./types";

/**
 * A Durable Object that has installed the Agents SDK Lifecycle.
 *
 * Pass a more specific Agent type to {@link getCurrentAgent} when shared code
 * needs APIs implemented by a particular Agent.
 */
export interface Agent<
  Env extends object = Cloudflare.Env,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends DurableObject<Env> {
  readonly lifecycle: Lifecycle<Env, Props>;
  onStart?(props?: Props): void | Promise<void>;
  onRequest?(request: Request): Response | Promise<Response>;
  onAlarm?(): void | Promise<void>;
  onConnect?(
    connection: Connection,
    context: ConnectionContext
  ): void | Promise<void>;
  onMessage?(connection: Connection, message: WSMessage): void | Promise<void>;
  onClose?(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): void | Promise<void>;
  onError?(connection: Connection, error: unknown): void | Promise<void>;
  getConnectionTags?(
    connection: Connection,
    context: ConnectionContext
  ): string[] | Promise<string[]>;
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
  Host extends DurableObject = Agent,
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
 * Return the current Lifecycle Agent and invocation-specific values.
 *
 * Startup and alarm hooks receive the current Agent with no request. Request
 * hooks additionally receive the request being handled. Lifecycle-managed
 * WebSocket hooks receive their connection and, during connect, its upgrade
 * request. Agent extensions may also establish context for email, chat turns,
 * callable methods, and detached work.
 */
export function getCurrentAgent<
  Host extends DurableObject = Agent
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

type LifecycleInvocationContext<
  Env extends object,
  Props extends Record<string, unknown>
> = {
  readonly host: Agent<Env, Props>;
  readonly connection?: Connection;
  readonly request?: Request;
};

/** Run one semantic phase in the invocation context of its Lifecycle Agent. */
export function runInLifecycleInvocation<
  Env extends object,
  Props extends Record<string, unknown>,
  T
>(context: LifecycleInvocationContext<Env, Props>, operation: () => T): T {
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
