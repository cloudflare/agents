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
 * Extension source format — a JS object expression defining tools:
 *
 * ```js
 * ({
 *   greet: {
 *     description: "Greet someone",
 *     parameters: { name: { type: "string" } },
 *     required: ["name"],
 *     execute: async (args, host) => `Hello, ${args.name}!`
 *   }
 * })
 * ```
 *
 * The `host` parameter in execute is provided via `env.host` — a loopback
 * binding that resolves the parent agent and delegates workspace operations
 * (gated by permissions). See HostBridgeLoopback.
 */

import { tool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
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

interface ExtensionEntrypoint {
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
   * createHostBinding: (permissions) =>
   *   ctx.exports.HostBridgeLoopback({
   *     props: { agentClassName: "ChatSession", agentId: ctx.id.toString(), permissions }
   *   })
   * ```
   */
  createHostBinding?: (permissions: ExtensionPermissions) => Fetcher;
}

export class ExtensionManager {
  #loader: WorkerLoader;
  #storage: DurableObjectStorage | null;
  #createHostBinding: ((permissions: ExtensionPermissions) => Fetcher) | null;
  #extensions = new Map<string, LoadedExtension>();
  #restored = false;
  #onUnload:
    | ((name: string, contextLabels: string[]) => void | Promise<void>)
    | null = null;

  constructor(options: ExtensionManagerOptions) {
    this.#loader = options.loader;
    this.#storage = options.storage ?? null;
    this.#createHostBinding = options.createHostBinding ?? null;
  }

  /**
   * Load an extension from source code.
   *
   * The source is a JS object expression defining tools. Each tool has
   * `description`, `parameters` (JSON Schema properties), optional
   * `required` array, and an `execute` async function.
   *
   * @returns Summary of the loaded extension including discovered tools.
   */
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
    const workerModule = wrapExtensionSource(source);
    const permissions = manifest.permissions ?? {};

    // Build env bindings for the dynamic worker. Inject a loopback
    // Fetcher as env.host when the extension declares ANY permission
    // that requires host access (workspace, context, messages, session).
    const workerEnv: Record<string, Fetcher> = {};
    const needsHost =
      (permissions.workspace ?? "none") !== "none" ||
      permissions.context?.read !== undefined ||
      permissions.context?.write !== undefined ||
      (permissions.messages ?? "none") !== "none" ||
      permissions.session?.sendMessage ||
      permissions.session?.metadata;
    if (this.#createHostBinding && needsHost) {
      workerEnv.host = this.#createHostBinding(permissions);
    }

    const worker = this.#loader.get(
      `ext-${manifest.name}-${manifest.version}-${Date.now()}`,
      () => ({
        compatibilityDate: "2025-06-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "extension.js",
        modules: { "extension.js": workerModule },
        globalOutbound: permissions.network?.length ? undefined : null,
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

    this.#extensions.set(manifest.name, {
      manifest,
      tools,
      hooks,
      entrypoint
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
    const tools: ToolSet = {};

    for (const ext of this.#extensions.values()) {
      const prefix = sanitizeName(ext.manifest.name);

      for (const descriptor of ext.tools) {
        const toolName = `${prefix}_${descriptor.name}`;

        tools[toolName] = tool({
          description: `[${ext.manifest.name}] ${descriptor.description}`,
          inputSchema: jsonSchema(
            descriptor.inputSchema as Record<string, unknown>
          ),
          execute: async (args: Record<string, unknown>) => {
            if (!this.#extensions.has(ext.manifest.name)) {
              throw new Error(
                `Extension "${ext.manifest.name}" has been unloaded. Tool "${toolName}" is no longer available.`
              );
            }
            const resultJson = await ext.entrypoint.execute(
              descriptor.name,
              JSON.stringify(args)
            );
            const parsed = JSON.parse(resultJson) as {
              result?: unknown;
              error?: string;
            };
            if (parsed.error) throw new Error(parsed.error);
            return parsed.result;
          }
        });
      }
    }

    return tools;
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
      const result = await fn(ctxSnapshot);
      return JSON.stringify({ result: result ?? {} });
    } catch (err) {
      return JSON.stringify({ error: err.message || String(err) });
    }
  }
}
`;
}
