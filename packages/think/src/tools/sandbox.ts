import type { ToolSet } from "ai";

let warned = false;

export interface CreateSandboxToolsOptions {
  /**
   * Execution timeout in milliseconds. Defaults to 30000 (30s).
   */
  timeout?: number;
}

/**
 * Create sandbox tools for Think agents.
 *
 * Sandbox tools provide isolated execution environments configured
 * per-agent with toolchains, repos, and snapshots.
 *
 * **Not yet implemented** — this export returns an empty `ToolSet` so
 * that `...createSandboxTools(env.SANDBOX)` compiles and spreads
 * harmlessly. A warning is logged at creation time.
 *
 * @example
 * ```ts
 * import { Think } from "@cloudflare/think";
 * import { createSandboxTools } from "@cloudflare/think/tools/sandbox";
 *
 * export class MyAgent extends Think<Env> {
 *   getTools() {
 *     return {
 *       ...createSandboxTools(this.env.SANDBOX),
 *     };
 *   }
 * }
 * ```
 */
export function createSandboxTools(
  _binding?: unknown,
  _options?: CreateSandboxToolsOptions
): ToolSet {
  if (!warned) {
    warned = true;
    console.warn(
      "[@cloudflare/think] createSandboxTools is not yet implemented. " +
        "No tools will be registered."
    );
  }

  return {};
}
