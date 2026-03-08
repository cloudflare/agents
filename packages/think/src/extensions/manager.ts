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
 * The `host` parameter in execute is a HostBridge RpcTarget providing
 * controlled access to the workspace (gated by permissions).
 */

import { tool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type { Workspace } from "agents/experimental/workspace";
import { HostBridge } from "./host-bridge";
import type {
  ExtensionManifest,
  ExtensionInfo,
  ExtensionToolDescriptor
} from "./types";

/**
 * Sanitize a name for use as a tool name prefix.
 * Replaces any non-alphanumeric characters with underscores and
 * collapses consecutive underscores.
 */
export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_");
}

interface ExtensionEntrypoint {
  describe(): Promise<string>;
  execute(
    toolName: string,
    argsJson: string,
    bridge: HostBridge
  ): Promise<string>;
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
  /** Workspace instance for extensions that declare workspace access. */
  workspace?: Workspace;
  /**
   * Durable Object storage for persisting extensions across hibernation.
   * If provided, loaded extensions survive DO restarts. Call `restore()`
   * on each turn to rebuild in-memory state from storage.
   */
  storage?: DurableObjectStorage;
}

export class ExtensionManager {
  #loader: WorkerLoader;
  #workspace: Workspace | null;
  #storage: DurableObjectStorage | null;
  #extensions = new Map<string, LoadedExtension>();
  #restored = false;

  constructor(options: ExtensionManagerOptions) {
    this.#loader = options.loader;
    this.#workspace = options.workspace ?? null;
    this.#storage = options.storage ?? null;
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

    const worker = this.#loader.get(
      `ext-${manifest.name}-${manifest.version}-${Date.now()}`,
      () => ({
        compatibilityDate: "2025-06-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "extension.js",
        modules: { "extension.js": workerModule },
        globalOutbound: permissions.network?.length ? undefined : null
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
      const permissions = ext.manifest.permissions ?? {};
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
            const bridge = new HostBridge(this.#workspace, permissions);
            const resultJson = await ext.entrypoint.execute(
              descriptor.name,
              JSON.stringify(args),
              bridge
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

  async execute(toolName, argsJson, bridge) {
    const def = __tools[toolName];
    if (!def || !def.execute) {
      return JSON.stringify({ error: "Unknown tool: " + toolName });
    }
    try {
      const args = JSON.parse(argsJson);
      const result = await def.execute(args, bridge);
      return JSON.stringify({ result });
    } catch (err) {
      return JSON.stringify({ error: err.message || String(err) });
    }
  }
}
`;
}
