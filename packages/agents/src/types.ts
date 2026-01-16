/**
 * Enum for message types to improve type safety and maintainability
 */
export enum MessageType {
  CF_AGENT_MCP_SERVERS = "cf_agent_mcp_servers",
  CF_MCP_AGENT_EVENT = "cf_mcp_agent_event",
  CF_AGENT_STATE = "cf_agent_state",
  RPC = "rpc"
}

/**
 * Fetch handler with Props support for ExecutionContext
 */
export type ExportedHandlerFetchHandler<
  Env = unknown,
  Props = unknown,
  CfHostMetadata = unknown
> = (
  request: Request<CfHostMetadata, IncomingRequestCfProperties<CfHostMetadata>>,
  env: Env,
  ctx: ExecutionContext<Props>
) => Response | Promise<Response>;

/**
 * Tail handler with Props support for ExecutionContext
 */
export type ExportedHandlerTailHandler<Env = unknown, Props = unknown> = (
  events: TraceItem[],
  env: Env,
  ctx: ExecutionContext<Props>
) => void | Promise<void>;

/**
 * Trace handler with Props support for ExecutionContext
 */
export type ExportedHandlerTraceHandler<Env = unknown, Props = unknown> = (
  traces: TraceItem[],
  env: Env,
  ctx: ExecutionContext<Props>
) => void | Promise<void>;

/**
 * TailStream handler with Props support for ExecutionContext
 */
export type ExportedHandlerTailStreamHandler<Env = unknown, Props = unknown> = (
  event: TailStream.TailEvent<TailStream.Onset>,
  env: Env,
  ctx: ExecutionContext<Props>
) => TailStream.TailEventHandlerType | Promise<TailStream.TailEventHandlerType>;

/**
 * Scheduled handler with Props support for ExecutionContext
 */
export type ExportedHandlerScheduledHandler<Env = unknown, Props = unknown> = (
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext<Props>
) => void | Promise<void>;

/**
 * Queue handler with Props support for ExecutionContext
 */
export type ExportedHandlerQueueHandler<
  Env = unknown,
  Props = unknown,
  Message = unknown
> = (
  batch: MessageBatch<Message>,
  env: Env,
  ctx: ExecutionContext<Props>
) => void | Promise<void>;

/**
 * Test handler with Props support for ExecutionContext
 */
export type ExportedHandlerTestHandler<Env = unknown, Props = unknown> = (
  controller: TestController,
  env: Env,
  ctx: ExecutionContext<Props>
) => void | Promise<void>;

/**
 * Enhanced ExportedHandler interface that supports Props flowing to ExecutionContext.
 *
 * This interface extends the base @cloudflare/workers-types ExportedHandler
 * to add a Props type parameter that flows through to ExecutionContext<Props>
 * in all handler methods.
 *
 * @typeParam Env - The environment bindings type
 * @typeParam Props - Props type that flows to ExecutionContext<Props>, making ctx.props typed
 * @typeParam QueueHandlerMessage - Message type for queue handlers
 * @typeParam CfHostMetadata - CF metadata type for fetch handlers
 *
 * @example
 * ```typescript
 * import type { ExportedHandler } from "agents/types";
 *
 * type Env = { DB: D1Database };
 * type Props = { userId: string };
 *
 * export default {
 *   async fetch(request, env, ctx) {
 *     // ctx.props is now typed as Props
 *     const userId = ctx.props.userId;
 *     return new Response(`Hello ${userId}`);
 *   },
 *   async scheduled(controller, env, ctx) {
 *     // ctx.props is also typed here
 *     console.log(ctx.props.userId);
 *   }
 * } satisfies ExportedHandler<Env, Props>;
 * ```
 */
export interface ExportedHandler<
  Env = unknown,
  Props = unknown,
  QueueHandlerMessage = unknown,
  CfHostMetadata = unknown
> {
  fetch?: ExportedHandlerFetchHandler<Env, Props, CfHostMetadata>;
  tail?: ExportedHandlerTailHandler<Env, Props>;
  trace?: ExportedHandlerTraceHandler<Env, Props>;
  tailStream?: ExportedHandlerTailStreamHandler<Env, Props>;
  scheduled?: ExportedHandlerScheduledHandler<Env, Props>;
  test?: ExportedHandlerTestHandler<Env, Props>;
  email?: EmailExportedHandler<Env>;
  queue?: ExportedHandlerQueueHandler<Env, Props, QueueHandlerMessage>;
}
