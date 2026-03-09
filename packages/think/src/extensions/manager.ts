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
  execute(toolName: string, argsJson: string): Promise<string>;
}

interface LoadedExtension {
  manifest: ExtensionManifest;
  tools: ExtensionToolDescriptor[];
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

    // Build env bindings for the dynamic worker. If a host binding
    // factory is configured and the extension declares workspace
    // access, inject a loopback Fetcher as env.host.
    const workerEnv: Record<string, Fetcher> = {};
    const wsLevel = permissions.workspace ?? "none";
    if (this.#createHostBinding && wsLevel !== "none") {
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

    // Discover tools via RPC
    const descriptorsJson = await entrypoint.describe();
    const tools = JSON.parse(descriptorsJson) as ExtensionToolDescriptor[];

    this.#extensions.set(manifest.name, { manifest, tools, entrypoint });

    return toExtensionInfo(manifest, tools);
  }

  /**
   * Unload an extension, removing its tools from the agent.
   */
  async unload(name: string): Promise<boolean> {
    const removed = this.#extensions.delete(name);
    if (removed && this.#storage) {
      await this.#storage.delete(`${STORAGE_PREFIX}${name}`);
    }
    return removed;
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
    permissions: manifest.permissions ?? {}
  };
}

/**
 * Wrap an extension source (JS object expression) in a Worker module
 * that exposes describe() and execute() RPC methods.
 */
function wrapExtensionSource(source: string): string {
  return `import { WorkerEntrypoint } from "cloudflare:workers";

const __tools = (${source});

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
}
`;
}
