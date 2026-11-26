/**
 * How a Think agent sets up its extensions and sends them its turn events.
 *
 * @internal
 */
import type { Context } from "agents/context";
import type { ToolSet, TypedToolCall } from "ai";
import type {
  ChunkContext,
  ExtensionConfig,
  StepContext,
  TurnConfig,
  TurnContext
} from "../turn-types";
import {
  createChunkSnapshot,
  createStepFinishSnapshot,
  createToolCallFinishSnapshot,
  createToolCallStartSnapshot,
  createTurnContextSnapshot
} from "./hook-proxy";
import type { ExtensionManager as ExtensionCore } from "agents/internal";
import {
  asNetworkGateway,
  ExtensionManager,
  sanitizeName,
  type ReleasedHookName,
  type ReleasedHooks
} from "./manager";
import type { ExtensionPermissions } from "./types";

/**
 * What {@link createThinkExtensionManager} needs from the agent.
 *
 * @internal
 */
interface ThinkExtensionManagerOptions {
  readonly loader: WorkerLoader;
  readonly storage: DurableObjectStorage;
  readonly agentClassName: string;
  readonly agentId: string;
  /** The agent's path from the root, root first (`Agent#selfPath`). */
  readonly agentPath: readonly { className: string; name: string }[];
  /** The root's jurisdiction, for a sub-agent's lookup of its root. */
  readonly rootJurisdiction: DurableObjectJurisdiction | undefined;
  /** `ctx.exports` of the agent's Durable Object. */
  readonly exports: Record<string, unknown> | undefined;
}

/**
 * Create the extension manager. Extensions get a host binding only when the
 * Worker entry re-exports `HostBridgeLoopback`.
 *
 * @internal
 */
export function createThinkExtensionManager(
  options: ThinkExtensionManagerOptions
): ExtensionManager {
  const { agentClassName, agentId, agentPath, rootJurisdiction, exports } =
    options;
  const hasBridge = exports && typeof exports.HostBridgeLoopback === "function";

  return new ExtensionManager({
    loader: options.loader,
    storage: options.storage,
    ...(hasBridge
      ? {
          workerIdScope: `${agentClassName}:${agentId}`,
          createHostBinding: asNetworkGateway(
            (permissions: ExtensionPermissions, ownContextLabels: string[]) =>
              (
                exports.HostBridgeLoopback as (opts: {
                  props: Record<string, unknown>;
                }) => Fetcher
              )({
                props: {
                  agentClassName,
                  agentId,
                  // A sub-agent is reached through its root.
                  ...(agentPath.length > 1 && {
                    agentPath: agentPath.map(({ className, name }) => ({
                      className,
                      name
                    })),
                    ...(rootJurisdiction && { rootJurisdiction })
                  }),
                  permissions,
                  ownContextLabels
                }
              })
          )
        }
      : {})
  });
}

/**
 * Load the static extensions, restore the dynamic ones from storage, and
 * register each extension's context blocks under a name-prefixed label.
 * Unloading an extension removes its blocks.
 *
 * @internal
 */
export async function loadThinkExtensions(
  manager: ExtensionManager,
  configs: ExtensionConfig[],
  context: Context
): Promise<void> {
  for (const config of configs) {
    await manager.load(config.manifest, config.source);
  }

  await manager.restore();

  // Context blocks use SQLite-backed storage on the agent. Extensions write
  // to their blocks through `host.setContext()`.
  for (const ext of manager.list()) {
    const manifest = manager.getManifest(ext.name);
    if (!manifest?.context) continue;

    const prefix = sanitizeName(ext.name);
    for (const ctxDef of manifest.context) {
      await context.addBlock({
        label: `${prefix}_${ctxDef.label}`,
        description: ctxDef.description,
        maxTokens: ctxDef.maxTokens
      });
    }
  }

  manager.onUnload(async (_name, contextLabels) => {
    for (const label of contextLabels) {
      context.removeBlock(label);
    }
    await context.refreshSystemPrompt();
  });
}

/**
 * Sends one agent's turn events to its extensions' hooks. Each event's
 * snapshot is made only when an extension subscribes to it.
 *
 * @internal
 */
export class ThinkExtensionHooks {
  readonly #core: () => ExtensionCore<ReleasedHooks> | undefined;

  constructor(core: () => ExtensionCore<ReleasedHooks> | undefined) {
    this.#core = core;
  }

  /**
   * Fold `config` (what the subclass's `beforeTurn` returned) through every
   * extension that subscribes to `beforeTurn`, in load order.
   */
  async beforeTurn(ctx: TurnContext, config: TurnConfig): Promise<TurnConfig> {
    const core = this.#core();
    if (!core || !(await core.subscribed("beforeTurn"))) return config;
    // Extensions see the subclass's system prompt.
    const snapshot = createTurnContextSnapshot(ctx, config.model ?? undefined);
    if (config.system !== undefined) snapshot.system = config.system;
    return core.hook("beforeTurn", { snapshot, config });
  }

  /** Tell subscribed extensions a tool call is about to run. */
  toolCallStart(event: {
    toolCall: TypedToolCall<ToolSet>;
    stepNumber: number | undefined;
  }): Promise<void> {
    return this.#observe("beforeToolCall", () =>
      createToolCallStartSnapshot(event)
    );
  }

  /** Tell subscribed extensions a tool call finished. */
  toolCallFinish(event: {
    toolCall: TypedToolCall<ToolSet>;
    stepNumber: number | undefined;
    durationMs: number;
    success: boolean;
    output?: unknown;
    error?: unknown;
  }): Promise<void> {
    return this.#observe("afterToolCall", () =>
      createToolCallFinishSnapshot(event)
    );
  }

  /** Tell subscribed extensions a step finished. */
  stepFinish(event: StepContext): Promise<void> {
    return this.#observe("onStepFinish", () => createStepFinishSnapshot(event));
  }

  /**
   * Tell subscribed extensions about a stream chunk. This runs per token, so
   * an extension that subscribes pays an RPC per chunk.
   */
  chunk(event: ChunkContext): Promise<void> {
    return this.#observe("onChunk", () =>
      createChunkSnapshot(event as { chunk: { type: string } })
    );
  }

  async #observe(
    hook: Exclude<ReleasedHookName, "beforeTurn">,
    snapshot: () => unknown
  ): Promise<void> {
    const core = this.#core();
    if (!core || !(await core.subscribed(hook))) return;
    await core.hook(hook, snapshot());
  }
}
