/**
 * Extension system types.
 *
 * Extensions are sandboxed Workers loaded on demand via WorkerLoader.
 * Each extension provides tools that the agent can use, with controlled
 * access to the host (workspace, network) via permissions.
 */

/**
 * Manifest declaring an extension's identity, permissions, and contributions.
 * Passed to ExtensionManager.load() alongside the extension source.
 */
export interface ExtensionManifest {
  /** Unique name for this extension (used as namespace prefix for tools and context). */
  name: string;
  /** Semver version string. */
  version: string;
  /** Human-readable description. */
  description?: string;
  /** Permission declarations — controls what the extension can access. */
  permissions?: ExtensionPermissions;

  /**
   * Context blocks contributed by this extension.
   * Labels are namespaced as `{extName}_{label}` at registration.
   * Currently backed by SQLite storage — extensions write via
   * `host.setContext()`. Direct RPC delegation is planned for Phase 4.
   */
  context?: Array<{
    /** Block label (namespaced as {extName}_{label}). */
    label: string;
    /** Human-readable description shown in the system prompt header. */
    description?: string;
    /** Block type determines which tools are generated.
     * Note: not yet enforced — all blocks use SQLite-backed storage
     * until bridge providers are implemented (Phase 4). */
    type: "readonly" | "writable" | "skill" | "searchable";
    /** Maximum token budget for this block. */
    maxTokens?: number;
  }>;

  /**
   * Lifecycle hooks this extension provides handlers for.
   * The extension Worker must expose corresponding RPC methods.
   */
  hooks?: Array<
    | "beforeTurn"
    | "beforeToolCall"
    | "afterToolCall"
    | "onStepFinish"
    | "onChunk"
  >;
}

export interface ExtensionPermissions {
  /**
   * Allowed network hosts. If empty or undefined, the extension has
   * no outbound network access (globalOutbound: null).
   * If set, the extension inherits the parent Worker's network.
   *
   * Note: per-host filtering is not yet enforced at the runtime level.
   * This field serves as a declaration of intent; actual enforcement
   * is all-or-nothing via globalOutbound.
   */
  network?: string[];

  /**
   * Workspace access level.
   * - "none" (default): no workspace access
   * - "read": can read files and list directories
   * - "read-write": can read, write, and delete files
   */
  workspace?: "read" | "read-write" | "none";
}

/**
 * Tool descriptor returned by the extension's describe() method.
 * Uses JSON Schema for input validation.
 */
export interface ExtensionToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Summary of a loaded extension, returned by ExtensionManager.list().
 */
export interface ExtensionInfo {
  name: string;
  version: string;
  description?: string;
  /** Names of tools provided by this extension. */
  tools: string[];
  /** Namespaced context labels contributed by this extension. */
  contextLabels: string[];
  permissions: ExtensionPermissions;
}
