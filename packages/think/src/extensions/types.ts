/**
 * Extension system types.
 *
 * Extensions are sandboxed Workers loaded on demand via WorkerLoader.
 * Each extension provides tools that the agent can use, with controlled
 * access to the host (workspace, network) via permissions.
 */

/**
 * Manifest declaring an extension's identity and permissions.
 * Passed to ExtensionManager.load() alongside the extension source.
 */
export interface ExtensionManifest {
  /** Unique name for this extension (used as namespace prefix for tools). */
  name: string;
  /** Semver version string. */
  version: string;
  /** Human-readable description. */
  description?: string;
  /** Permission declarations — controls what the extension can access. */
  permissions?: ExtensionPermissions;
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
  permissions: ExtensionPermissions;
}
