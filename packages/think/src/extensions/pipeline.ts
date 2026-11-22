/**
 * How a Think agent sets up its sandboxed extensions and runs their hooks.
 *
 * `beforeTurn` is a pipeline: each subscribed extension, in load order, sees
 * the config the earlier ones produced and may change its serializable
 * fields. The other hooks are observation only. Every hook call has a
 * per-extension timeout, and a failing extension is logged and skipped.
 */

import type { ToolSet, TypedToolCall } from "ai";
import type { ContextBlocks } from "agents/context";
import type {
  ChunkContext,
  ExtensionConfig,
  StepContext,
  TurnConfig,
  TurnContext
} from "../turn-types";
import { ExtensionManager, sanitizeName } from "./manager";
import type { ExtensionPermissions } from "./types";

type ObservationHook =
  | "beforeToolCall"
  | "afterToolCall"
  | "onStepFinish"
  | "onChunk";

/**
 * `TurnConfig` fields an extension's `beforeTurn` may set, last write wins.
 * `model` and `tools` are not among them: a sandboxed extension cannot send a
 * `LanguageModel` or an AI SDK tool over RPC. It uses `activeTools` instead.
 */
const EXTENSION_SCALAR_CONFIG_KEYS = [
  "system",
  "messages",
  "activeTools",
  "toolChoice",
  "maxSteps",
  "sendReasoning",
  "maxOutputTokens",
  "temperature",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "stopSequences",
  "seed",
  "maxRetries",
  "timeout"
] as const satisfies ReadonlyArray<keyof TurnConfig>;

/**
 * What {@link createThinkExtensionManager} needs from the agent.
 *
 * @internal
 */
export interface ThinkExtensionManagerOptions {
  readonly loader: WorkerLoader;
  readonly storage: DurableObjectStorage;
  readonly agentClassName: string;
  readonly agentId: string;
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
  const { agentClassName, agentId, exports } = options;
  const hasBridge = exports && typeof exports.HostBridgeLoopback === "function";

  return new ExtensionManager({
    loader: options.loader,
    storage: options.storage,
    ...(hasBridge
      ? {
          workerIdScope: `${agentClassName}:${agentId}`,
          createHostBinding: (
            permissions: ExtensionPermissions,
            ownContextLabels: string[]
          ) =>
            (
              exports.HostBridgeLoopback as (opts: {
                props: Record<string, unknown>;
              }) => Fetcher
            )({
              props: {
                agentClassName,
                agentId,
                permissions,
                ownContextLabels
              }
            })
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
  context: ContextBlocks
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
 * Runs the extension hooks of one agent.
 *
 * @internal
 */
export class ThinkExtensionHooks {
  readonly #manager: () => ExtensionManager | undefined;
  readonly #timeoutMs: () => number;

  constructor(options: {
    manager: () => ExtensionManager | undefined;
    timeoutMs: () => number;
  }) {
    this.#manager = options.manager;
    this.#timeoutMs = options.timeoutMs;
  }

  /**
   * Pipe `config` (what the subclass's `beforeTurn` returned) through every
   * extension that subscribes to `beforeTurn`, in load order. Each one sees
   * the snapshot as the earlier ones left it.
   */
  async beforeTurn(ctx: TurnContext, config: TurnConfig): Promise<TurnConfig> {
    const manager = this.#manager();
    if (!manager) return config;

    const subscribers = manager.getHookSubscribers("beforeTurn");
    if (subscribers.length === 0) return config;

    const { createTurnContextSnapshot, parseHookResult } =
      await import("./hook-proxy");

    let snapshot = createTurnContextSnapshot(ctx, config.model ?? undefined);
    const accumulated: TurnConfig = { ...config };

    // Extensions see the subclass overrides.
    if (accumulated.system !== undefined) snapshot.system = accumulated.system;
    if (accumulated.maxSteps !== undefined)
      snapshot.messageCount = ctx.messages.length;

    for (const sub of subscribers) {
      try {
        const resultJson = await this.#withTimeout(
          sub.name,
          sub.entrypoint.hook("beforeTurn", snapshot)
        );

        const parsed = parseHookResult(resultJson);
        if ("config" in parsed) {
          const writable = accumulated as Record<string, unknown>;
          for (const key of EXTENSION_SCALAR_CONFIG_KEYS) {
            const value = parsed.config[key];
            if (value !== undefined) writable[key] = value;
          }
          if (parsed.config.headers !== undefined) {
            accumulated.headers = {
              ...(accumulated.headers ?? {}),
              ...parsed.config.headers
            };
          }
          if (parsed.config.providerOptions !== undefined) {
            accumulated.providerOptions = {
              ...(accumulated.providerOptions ?? {}),
              ...parsed.config.providerOptions
            };
          }
          // The next extension sees this one's changes.
          if (accumulated.system !== undefined)
            snapshot = { ...snapshot, system: accumulated.system };
          if (accumulated.activeTools !== undefined)
            snapshot = { ...snapshot, toolNames: accumulated.activeTools };
        } else if ("error" in parsed) {
          console.warn(
            `[Think] Extension "${sub.name}" beforeTurn error:`,
            parsed.error
          );
        }
      } catch (err) {
        console.warn(
          `[Think] Extension "${sub.name}" beforeTurn failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    return accumulated;
  }

  /** Tell subscribed extensions a tool call is about to run. */
  async toolCallStart(event: {
    toolCall: TypedToolCall<ToolSet>;
    stepNumber: number | undefined;
  }): Promise<void> {
    if (!this.#hasSubscribers("beforeToolCall")) return;
    const { createToolCallStartSnapshot } = await import("./hook-proxy");
    await this.#observe("beforeToolCall", createToolCallStartSnapshot(event));
  }

  /** Tell subscribed extensions a tool call finished. */
  async toolCallFinish(event: {
    toolCall: TypedToolCall<ToolSet>;
    stepNumber: number | undefined;
    durationMs: number;
    success: boolean;
    output?: unknown;
    error?: unknown;
  }): Promise<void> {
    if (!this.#hasSubscribers("afterToolCall")) return;
    const { createToolCallFinishSnapshot } = await import("./hook-proxy");
    await this.#observe("afterToolCall", createToolCallFinishSnapshot(event));
  }

  /** Tell subscribed extensions a step finished. */
  async stepFinish(event: StepContext): Promise<void> {
    if (!this.#hasSubscribers("onStepFinish")) return;
    const { createStepFinishSnapshot } = await import("./hook-proxy");
    await this.#observe("onStepFinish", createStepFinishSnapshot(event));
  }

  /**
   * Tell subscribed extensions about a stream chunk. This runs per token, so
   * an extension that subscribes pays an RPC per chunk.
   */
  async chunk(event: ChunkContext): Promise<void> {
    if (!this.#hasSubscribers("onChunk")) return;
    const { createChunkSnapshot } = await import("./hook-proxy");
    await this.#observe(
      "onChunk",
      createChunkSnapshot(event as { chunk: { type: string } })
    );
  }

  #hasSubscribers(hookName: ObservationHook): boolean {
    const manager = this.#manager();
    return !!manager && manager.getHookSubscribers(hookName).length > 0;
  }

  /** Send an observation to every subscriber. Return values are ignored. */
  async #observe(hookName: ObservationHook, snapshot: unknown): Promise<void> {
    const manager = this.#manager();
    if (!manager) return;
    for (const sub of manager.getHookSubscribers(hookName)) {
      try {
        await this.#withTimeout(
          sub.name,
          sub.entrypoint.hook(hookName, snapshot)
        );
      } catch (err) {
        console.warn(
          `[Think] Extension "${sub.name}" ${hookName} failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  async #withTimeout<T>(name: string, call: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Hook timeout: ${name}`)),
            this.#timeoutMs()
          );
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
