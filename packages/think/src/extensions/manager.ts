/**
 * ExtensionManager — loads, manages, and exposes tools from extension Workers.
 *
 * Extensions are sandboxed Workers created via WorkerLoader. Each extension
 * declares tools (with JSON Schema inputs) and permissions. The manager:
 *
 * 1. Wraps extension source in a Worker module with describe/execute RPC
 * 2. Loads it via WorkerLoader with permission-gated bindings
 * 3. Discovers tools via describe() RPC call
 * 4. Exposes them as AI SDK tools via getTools()
 *
 * Each loaded Worker is an extension handle of the extension core
 * (`agents/internal`), which builds the tools and runs the hooks.
 *
 * Extension source format — a JS object expression with `tools` and
 * `hooks`:
 *
 * ```js
 * ({
 *   tools: {
 *     greet: {
 *       description: "Greet someone",
 *       parameters: { name: { type: "string" } },
 *       required: ["name"],
 *       execute: async (args, host) => `Hello, ${args.name}!`
 *     }
 *   }
 * })
 * ```
 *
 * The `host` parameter in execute is provided via `env.host` — a loopback
 * binding that resolves the parent agent and delegates workspace operations
 * (gated by permissions). See HostBridgeLoopback.
 */

import type { ToolSet } from "ai";
import {
  ExtensionManager as ExtensionCore,
  toolsOf,
  type Drafts,
  type ExtensionHandle,
  type HookHandler,
  type HookRules,
  type ToolEntry,
  type ToolOutcome
} from "agents/internal";
import type { TurnConfig } from "../turn-types";
import { parseHookResult, type createTurnContextSnapshot } from "./hook-proxy";
import type {
  ExtensionManifest,
  ExtensionPermissions,
  ExtensionInfo,
  ExtensionToolDescriptor
} from "./types";

/**
 * Sanitize a name for use as a tool name prefix.
 * Replaces any non-alphanumeric characters with underscores and
 * collapses consecutive underscores.
 */
export function sanitizeName(name: string): string {
  if (!name || name.trim().length === 0) {
    throw new Error("Extension name must not be empty");
  }
  return name
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** @internal The RPC methods of a released extension's Worker. */
export interface ExtensionEntrypoint {
  describe(): Promise<string>;
  manifest(): Promise<string>;
  execute(toolName: string, argsJson: string): Promise<string>;
  hook(name: string, ctxProxy: unknown): Promise<string>;
}

interface LoadedExtension {
  manifest: ExtensionManifest;
  tools: ExtensionToolDescriptor[];
  hooks: string[];
  entrypoint: ExtensionEntrypoint;
  handle: ReleasedWorkerHandle;
}

/** Shape persisted to DO storage for each extension. */
interface PersistedExtension {
  manifest: ExtensionManifest;
  source: string;
}

const STORAGE_PREFIX = "ext:";

export interface ExtensionManagerOptions {
  /** WorkerLoader binding for creating sandboxed extension Workers. */
  loader: WorkerLoader;
  /**
   * Durable Object storage for persisting extensions across hibernation.
   * If provided, loaded extensions survive DO restarts. Call `restore()`
   * on each turn to rebuild in-memory state from storage.
   */
  storage?: DurableObjectStorage;
  /**
   * Factory that creates a loopback Fetcher for workspace access, given
   * an extension's declared permissions. The returned binding is injected
   * into the extension worker's `env.host`.
   *
   * If not provided, extensions receive no host binding (workspace tools
   * will get `null` for the host parameter).
   *
   * Typically wired up using HostBridgeLoopback via `ctx.exports`:
   * ```typescript
   * createHostBinding: (permissions, ownContextLabels) =>
   *   ctx.exports.HostBridgeLoopback({
   *     props: { agentClassName: "ChatSession", agentId: ctx.id.toString(), permissions, ownContextLabels }
   *   })
   * ```
   */
  createHostBinding?: (
    permissions: ExtensionPermissions,
    ownContextLabels: string[]
  ) => Fetcher;
  /**
   * Identifies the agent that `createHostBinding` binds to (for example
   * `${className}:${ctx.id}`). It is part of the Dynamic Worker id of
   * extensions that receive `env.host`, so a cached worker is never shared
   * with another agent. Without it, such extensions get a fresh id per
   * manager instance.
   */
  workerIdScope?: string;
}

async function hashWorkerConfig(input: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(input));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

type TurnSnapshot = ReturnType<typeof createTurnContextSnapshot>;

/**
 * The released hooks, with the snapshot each extension is sent. Only the
 * snapshot crosses to the extension; `beforeTurn`'s `config` is the fold's
 * starting point and stays here.
 *
 * @internal
 */
export type ReleasedHooks = {
  beforeTurn: [{ snapshot: TurnSnapshot; config: TurnConfig }, TurnConfig];
  beforeToolCall: [unknown, void];
  afterToolCall: [unknown, void];
  onStepFinish: [unknown, void];
  onChunk: [unknown, void];
};

/** @internal */
export type ReleasedHookName = keyof ReleasedHooks;

const RELEASED_HOOKS: readonly ReleasedHookName[] = [
  "beforeTurn",
  "beforeToolCall",
  "afterToolCall",
  "onStepFinish",
  "onChunk"
];

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

async function guarded<C, R>(
  hook: ReleasedHookName,
  handler: HookHandler<C, R>,
  context: C,
  timeoutMs: number
): Promise<R | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handler(context),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Hook timeout: ${handler.extension}`)),
          timeoutMs
        );
      })
    ]);
  } catch (error) {
    console.warn(
      `[Think] Extension "${handler.extension}" ${hook} failed:`,
      error instanceof Error ? error.message : error
    );
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * How the released hooks combine, with `timeoutMs` per call.
 *
 * @internal
 */
export function releasedHookRules(
  timeoutMs: () => number
): HookRules<ReleasedHooks> {
  const observeEach =
    (hook: ReleasedHookName) =>
    async (
      context: unknown,
      handlers: readonly HookHandler<unknown, void>[]
    ): Promise<void> => {
      for (const handler of handlers) {
        await guarded(hook, handler, context, timeoutMs());
      }
    };
  return {
    async beforeTurn({ snapshot: first, config }, handlers) {
      if (handlers.length === 0) return config;
      let snapshot = first;
      const accumulated: TurnConfig = { ...config };
      for (const handler of handlers) {
        const changes = await guarded(
          "beforeTurn",
          handler,
          { snapshot, config: accumulated },
          timeoutMs()
        );
        if (!changes) continue;
        const writable = accumulated as Record<string, unknown>;
        for (const key of EXTENSION_SCALAR_CONFIG_KEYS) {
          const value = changes[key];
          if (value !== undefined) writable[key] = value;
        }
        if (changes.headers !== undefined) {
          accumulated.headers = {
            ...(accumulated.headers ?? {}),
            ...changes.headers
          };
        }
        if (changes.providerOptions !== undefined) {
          accumulated.providerOptions = {
            ...(accumulated.providerOptions ?? {}),
            ...changes.providerOptions
          };
        }
        // The next extension sees this one's changes.
        if (accumulated.system !== undefined) {
          snapshot = { ...snapshot, system: accumulated.system };
        }
        if (accumulated.activeTools !== undefined) {
          snapshot = { ...snapshot, toolNames: accumulated.activeTools };
        }
      }
      return accumulated;
    },
    beforeToolCall: observeEach("beforeToolCall"),
    afterToolCall: observeEach("afterToolCall"),
    onStepFinish: observeEach("onStepFinish"),
    onChunk: observeEach("onChunk")
  };
}

/**
 * A released extension's Worker, as an extension handle. Its tools are
 * fixed when it loads: each is offered as `<extension>_<tool>`, described
 * as `[<extension>] <description>`.
 *
 * @internal
 */
export class ReleasedWorkerHandle implements ExtensionHandle<ReleasedHooks> {
  readonly entries: readonly (readonly [string, ToolEntry])[];
  readonly #manifest: ExtensionManifest;
  readonly #entrypoint: ExtensionEntrypoint;
  readonly #hooks: readonly ReleasedHookName[];
  /** The tool each offered name runs. */
  readonly #toolNames = new Map<string, string>();
  #unloaded = false;

  constructor(
    manifest: ExtensionManifest,
    entrypoint: ExtensionEntrypoint,
    tools: readonly ExtensionToolDescriptor[],
    hooks: readonly string[]
  ) {
    this.#manifest = manifest;
    this.#entrypoint = entrypoint;
    this.#hooks = RELEASED_HOOKS.filter((hook) => hooks.includes(hook));
    const prefix = sanitizeName(manifest.name);
    this.entries = tools.map((descriptor) => {
      const name = `${prefix}_${descriptor.name}`;
      this.#toolNames.set(name, descriptor.name);
      const entry: ToolEntry = {
        owner: manifest.name,
        definition: {
          description: `[${manifest.name}] ${descriptor.description}`
        },
        // SAFETY: a descriptor's input schema is a JSON Schema object.
        inputSchema: descriptor.inputSchema as ToolEntry["inputSchema"],
        execute: true,
        validate: false,
        modelOutput: false,
        streams: false
      };
      return [name, entry] as const;
    });
  }

  /** Its tools answer as unloaded from now on. */
  unload(): void {
    this.#unloaded = true;
  }

  async describe() {
    return { hooks: this.#hooks };
  }

  async build(drafts: Drafts): Promise<Drafts> {
    const tools = new Map(drafts.tools);
    for (const [name, entry] of this.entries) tools.set(name, entry);
    return { tools: [...tools], prompt: drafts.prompt };
  }

  async execute(name: string, input: unknown): Promise<ToolOutcome> {
    if (this.#unloaded) {
      return {
        ok: false,
        errorText: `Extension "${this.#manifest.name}" has been unloaded. Tool "${name}" is no longer available.`
      };
    }
    const resultJson = await this.#entrypoint.execute(
      this.#toolNames.get(name) ?? name,
      JSON.stringify(input)
    );
    const parsed = JSON.parse(resultJson) as {
      result?: unknown;
      error?: string;
    };
    return parsed.error
      ? { ok: false, errorText: parsed.error }
      : { ok: true, output: parsed.result };
  }

  /** The released protocol has no way to stop a call. */
  cancel(): void {}

  async validate(): Promise<never> {
    throw new Error("A released extension's tools take JSON Schema input");
  }

  async modelOutput(): Promise<never> {
    throw new Error("A released extension's tools have no toModelOutput");
  }

  async needsApproval(): Promise<boolean> {
    return false;
  }

  async hook<H extends ReleasedHookName>(
    name: H,
    context: ReleasedHooks[H][0]
  ): Promise<ReleasedHooks[H][1]> {
    const payload =
      name === "beforeTurn"
        ? (context as ReleasedHooks["beforeTurn"][0]).snapshot
        : context;
    const parsed = parseHookResult(await this.#entrypoint.hook(name, payload));
    if ("error" in parsed) throw new Error(parsed.error);
    // SAFETY: only `beforeTurn` returns something; the observers' results
    // are ignored.
    return (
      "config" in parsed && name === "beforeTurn" ? parsed.config : undefined
    ) as ReleasedHooks[H][1];
  }
}

/** Each manager's extension core, and the hook timeout it runs under. */
const cores = new WeakMap<
  ExtensionManager,
  { core: ExtensionCore<ReleasedHooks>; timeoutMs: () => number }
>();

/**
 * The extension core behind `manager`, which runs its extensions' hooks
 * with the agent's `timeoutMs` per call. A manager the agent was given
 * runs under the agent's timeout too.
 *
 * @internal
 */
export function coreOf(
  manager: ExtensionManager,
  timeoutMs: () => number
): ExtensionCore<ReleasedHooks> | undefined {
  const entry = cores.get(manager);
  if (entry) entry.timeoutMs = timeoutMs;
  return entry?.core;
}

const DEFAULT_HOOK_TIMEOUT_MS = 5000;

export class ExtensionManager {
  #loader: WorkerLoader;
  #storage: DurableObjectStorage | null;
  #createHostBinding:
    | ((
        permissions: ExtensionPermissions,
        ownContextLabels: string[]
      ) => Fetcher)
    | null;
  #workerIdScope: string;
  #extensions = new Map<string, LoadedExtension>();
  readonly #core: ExtensionCore<ReleasedHooks>;
  #restored = false;
  #warnedContextType = false;
  #warnedNetwork = false;
  #onUnload:
    | ((name: string, contextLabels: string[]) => void | Promise<void>)
    | null = null;

  constructor(options: ExtensionManagerOptions) {
    this.#loader = options.loader;
    this.#storage = options.storage ?? null;
    this.#createHostBinding = options.createHostBinding ?? null;
    this.#workerIdScope = options.workerIdScope ?? crypto.randomUUID();
    const entry: {
      core: ExtensionCore<ReleasedHooks>;
      timeoutMs: () => number;
    } = {
      core: new ExtensionCore(releasedHookRules(() => entry.timeoutMs())),
      timeoutMs: () => DEFAULT_HOOK_TIMEOUT_MS
    };
    this.#core = entry.core;
    cores.set(this, entry);
  }

  /**
   * Restore extensions from DO storage after hibernation.
   *
   * Idempotent — skips extensions already in memory. Call this at the
   * start of each chat turn (e.g. in onChatMessage before getTools).
   */
  async restore(): Promise<void> {
    if (this.#restored || !this.#storage) return;
    this.#restored = true;

    const entries = await this.#storage.list<PersistedExtension>({
      prefix: STORAGE_PREFIX
    });

    for (const persisted of entries.values()) {
      if (this.#extensions.has(persisted.manifest.name)) continue;
      await this.#loadInternal(persisted.manifest, persisted.source);
    }
  }

  /**
   * Load an extension from source code.
   *
   * The source is a JS object expression with `tools` and `hooks`. Each
   * tool has `description`, `parameters` (JSON Schema properties), optional
   * `required` array, and an `execute` async function.
   *
   * @returns Summary of the loaded extension including discovered tools.
   */
  async load(
    manifest: ExtensionManifest,
    source: string
  ): Promise<ExtensionInfo> {
    if (this.#extensions.has(manifest.name)) {
      throw new Error(
        `Extension "${manifest.name}" is already loaded. Unload it first.`
      );
    }

    const info = await this.#loadInternal(manifest, source);

    // Persist to storage so it survives hibernation
    if (this.#storage) {
      await this.#storage.put<PersistedExtension>(
        `${STORAGE_PREFIX}${manifest.name}`,
        { manifest, source }
      );
    }

    return info;
  }

  async #loadInternal(
    manifest: ExtensionManifest,
    source: string
  ): Promise<ExtensionInfo> {
    if (
      !this.#warnedContextType &&
      manifest.context?.some((block) => block.type !== undefined)
    ) {
      this.#warnedContextType = true;
      console.warn(
        `[Think] Extension "${manifest.name}": a context block's \`type\` is ignored. An extension writes its blocks with host.setContext(), which its context.write permission governs.`
      );
    }
    const workerModule = wrapExtensionSource(source);
    const permissions = manifest.permissions ?? {};

    // Build env bindings for the dynamic worker. Inject a loopback
    // Fetcher as env.host when the extension declares ANY permission
    // that requires host access (workspace, context, messages, session).
    const workerEnv: Record<string, Fetcher> = {};
    const prefix = sanitizeName(manifest.name);
    const ownLabels = (manifest.context ?? []).map(
      (c) => `${prefix}_${c.label}`
    );
    const needsHost =
      (permissions.workspace ?? "none") !== "none" ||
      permissions.context?.read !== undefined ||
      permissions.context?.write !== undefined ||
      (permissions.messages ?? "none") !== "none" ||
      permissions.session?.sendMessage ||
      permissions.session?.metadata;
    const needsNetwork = (permissions.network?.length ?? 0) > 0;
    const binding =
      this.#createHostBinding && (needsHost || needsNetwork)
        ? this.#createHostBinding(permissions, ownLabels)
        : undefined;
    if (binding && needsHost) workerEnv.host = binding;

    // The listed hosts are enforced by the host binding, which the Worker's
    // fetch() goes through. Without one there is nothing to enforce them,
    // so the Worker keeps the agent's network, as before.
    let globalOutbound: Fetcher | null | undefined = null;
    if (needsNetwork) {
      globalOutbound = binding;
      if (!binding && !this.#warnedNetwork) {
        this.#warnedNetwork = true;
        console.warn(
          `[Think] Extension "${manifest.name}": its network hosts are not enforced, because the Worker entry does not re-export HostBridgeLoopback. It can reach any host.`
        );
      }
    }

    // Stable, content-derived id: Dynamic Workers are billed per distinct
    // id, so restarts must reuse the id while code/permissions are unchanged.
    // A cached worker keeps the env and outbound it was created with, so an
    // id whose Worker carries the host binding must also cover the agent
    // and the context labels that binding was created for.
    const hash = await hashWorkerConfig({
      workerModule,
      globalOutbound:
        globalOutbound === null
          ? "null"
          : globalOutbound === undefined
            ? "inherit"
            : "gateway",
      envBindings: Object.keys(workerEnv).sort(),
      permissions,
      ...(binding
        ? { hostScope: this.#workerIdScope, ownContextLabels: ownLabels }
        : {})
    });

    const worker = this.#loader.get(
      `ext-${manifest.name}-${manifest.version}-${hash}`,
      () => ({
        compatibilityDate: "2025-06-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "extension.js",
        modules: { "extension.js": workerModule },
        globalOutbound,
        ...(Object.keys(workerEnv).length > 0 ? { env: workerEnv } : {})
      })
    );

    const entrypoint = worker.getEntrypoint() as unknown as ExtensionEntrypoint;

    // Discover tools and hooks via RPC
    const descriptorsJson = await entrypoint.describe();
    const tools = JSON.parse(descriptorsJson) as ExtensionToolDescriptor[];

    let hooks: string[] = [];
    try {
      const manifestJson = await entrypoint.manifest();
      const runtimeManifest = JSON.parse(manifestJson) as {
        hooks?: string[];
      };
      hooks = runtimeManifest.hooks ?? [];
    } catch {
      // Legacy extensions may not have manifest() — treat as no hooks
    }

    const handle = new ReleasedWorkerHandle(manifest, entrypoint, tools, hooks);
    this.#core.load(manifest.name, Promise.resolve(handle));
    this.#extensions.set(manifest.name, {
      manifest,
      tools,
      hooks,
      entrypoint,
      handle
    });

    return toExtensionInfo(manifest, tools);
  }

  /**
   * Unload an extension, removing its tools from the agent.
   * If an onUnload callback is registered, it fires with the
   * extension's namespaced context labels so the caller can
   * remove context blocks from the Session.
   */
  async unload(name: string): Promise<boolean> {
    const ext = this.#extensions.get(name);
    if (!ext) return false;

    const removed = this.#extensions.delete(name);
    this.#core.unload(name);
    ext.handle.unload();
    if (removed && this.#storage) {
      await this.#storage.delete(`${STORAGE_PREFIX}${name}`);
    }

    if (removed && this.#onUnload) {
      const prefix = sanitizeName(name);
      const contextLabels = (ext.manifest.context ?? []).map(
        (c) => `${prefix}_${c.label}`
      );
      await this.#onUnload(name, contextLabels);
    }

    return removed;
  }

  /**
   * Register a callback invoked when an extension is unloaded.
   * Think uses this to remove the extension's context blocks from Session.
   */
  onUnload(
    cb: (name: string, contextLabels: string[]) => void | Promise<void>
  ): void {
    this.#onUnload = cb;
  }

  /**
   * Get the namespaced context labels for all loaded extensions
   * that declare context blocks in their manifests.
   */
  getContextLabels(): Array<{ extName: string; label: string }> {
    const result: Array<{ extName: string; label: string }> = [];
    for (const ext of this.#extensions.values()) {
      if (!ext.manifest.context) continue;
      const prefix = sanitizeName(ext.manifest.name);
      for (const ctx of ext.manifest.context) {
        result.push({
          extName: ext.manifest.name,
          label: `${prefix}_${ctx.label}`
        });
      }
    }
    return result;
  }

  /**
   * Get extension manifest by name.
   */
  getManifest(name: string): ExtensionManifest | null {
    return this.#extensions.get(name)?.manifest ?? null;
  }

  /**
   * Get extensions that subscribe to a specific hook, in load order.
   */
  getHookSubscribers(
    hookName: string
  ): Array<{ name: string; entrypoint: ExtensionEntrypoint }> {
    const result: Array<{ name: string; entrypoint: ExtensionEntrypoint }> = [];
    for (const ext of this.#extensions.values()) {
      if (ext.hooks.includes(hookName)) {
        result.push({ name: ext.manifest.name, entrypoint: ext.entrypoint });
      }
    }
    return result;
  }

  /**
   * List all loaded extensions.
   */
  list(): ExtensionInfo[] {
    return [...this.#extensions.values()].map((ext) =>
      toExtensionInfo(ext.manifest, ext.tools)
    );
  }

  /**
   * Get AI SDK tools from all loaded extensions.
   *
   * Tool names are prefixed with the sanitized extension name to avoid
   * collisions: e.g. extension "github" with tool "create_pr" → "github_create_pr".
   */
  getTools(): ToolSet {
    const loaded = [...this.#extensions.values()];
    // Each released extension offers the tools it described at load, so
    // the build is the extensions' entries in load order.
    return toolsOf<ReleasedHooks>(
      loaded.flatMap(({ handle }) => handle.entries),
      new Map(loaded.map(({ manifest, handle }) => [manifest.name, handle])),
      ""
    );
  }
}

function toExtensionInfo(
  manifest: ExtensionManifest,
  tools: ExtensionToolDescriptor[]
): ExtensionInfo {
  const prefix = sanitizeName(manifest.name);
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    tools: tools.map((t) => `${prefix}_${t.name}`),
    contextLabels: (manifest.context ?? []).map((c) => `${prefix}_${c.label}`),
    permissions: manifest.permissions ?? {}
  };
}

/**
 * Wrap an extension source in a Worker module that exposes
 * describe(), execute(), manifest(), and hook RPC methods.
 *
 * Source format: `({ tools: {...}, hooks: {...} })`
 * Both `tools` and `hooks` are optional.
 */
function wrapExtensionSource(source: string): string {
  return `import { WorkerEntrypoint } from "cloudflare:workers";

const __ext = (${source});
if (__ext && typeof __ext === "object" && !("tools" in __ext) && !("hooks" in __ext)) {
  throw new Error(
    "Invalid extension source format. Expected { tools: {...}, hooks: {...} } " +
    "but got a flat object. Wrap your tools in a 'tools' key."
  );
}
const __tools = __ext.tools || {};
const __hooks = __ext.hooks || {};

export default class Extension extends WorkerEntrypoint {
  describe() {
    const descriptors = [];
    for (const [name, def] of Object.entries(__tools)) {
      descriptors.push({
        name,
        description: def.description || name,
        inputSchema: {
          type: "object",
          properties: def.parameters || {},
          required: def.required || []
        }
      });
    }
    return JSON.stringify(descriptors);
  }

  manifest() {
    return JSON.stringify({
      hooks: Object.keys(__hooks)
    });
  }

  async execute(toolName, argsJson) {
    const def = __tools[toolName];
    if (!def || !def.execute) {
      return JSON.stringify({ error: "Unknown tool: " + toolName });
    }
    try {
      const args = JSON.parse(argsJson);
      const result = await def.execute(args, this.env.host ?? null);
      return JSON.stringify({ result });
    } catch (err) {
      return JSON.stringify({ error: err.message || String(err) });
    }
  }

  async hook(name, ctxSnapshot) {
    const fn = __hooks[name];
    if (!fn) return JSON.stringify({ skipped: true });
    try {
      // Hook handlers receive (ctxSnapshot, host) — symmetric with tool
      // executes. \`host\` is null when the extension was loaded without
      // host-requiring permissions or when the worker entry point doesn't
      // re-export HostBridgeLoopback.
      const result = await fn(ctxSnapshot, this.env.host ?? null);
      return JSON.stringify({ result: result ?? {} });
    } catch (err) {
      return JSON.stringify({ error: err.message || String(err) });
    }
  }
}
`;
}
