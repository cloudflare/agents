/**
 * Framework-agnostic tool resolution.
 *
 * Extracts execute functions from tool records and resolves ToolProviders
 * into ResolvedProviders — no dependency on the AI SDK or Zod.
 *
 * The AI SDK entry point (`./ai`) layers on schema validation via `asSchema`.
 */

import type {
  ToolProvider,
  ToolProviderTools,
  ResolvedProvider
} from "./executor";

function hasNeedsApproval(t: Record<string, unknown>): boolean {
  return "needsApproval" in t && t.needsApproval != null;
}

/**
 * Filter out tools with needsApproval and return a clean copy.
 */
export function filterTools(tools: ToolProviderTools): ToolProviderTools {
  const filtered: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) {
    if (!hasNeedsApproval(t as Record<string, unknown>)) {
      filtered[name] = t;
    }
  }
  return filtered as ToolProviderTools;
}

/**
 * Extract execute functions from tools, keyed by name.
 * This is the base version — no schema validation.
 * The AI SDK entry point overrides this with `asSchema`-based validation.
 */
export function extractFns(
  tools: ToolProviderTools
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  for (const [name, t] of Object.entries(tools)) {
    const execute =
      "execute" in t
        ? (t.execute as (args: unknown) => Promise<unknown>)
        : undefined;
    if (execute) {
      fns[name] = execute;
    }
  }

  return fns;
}

/**
 * Resolve a ToolProvider into a ResolvedProvider ready for execution.
 * Filters out tools with `needsApproval`.
 *
 * This version does NOT perform schema validation on inputs.
 * Import from `@cloudflare/codemode/ai` for the schema-validating version.
 */
export function resolveProvider(provider: ToolProvider): ResolvedProvider {
  const name = provider.name ?? "codemode";
  const filtered = filterTools(provider.tools);
  const resolved: ResolvedProvider = { name, fns: extractFns(filtered) };
  if (provider.positionalArgs) resolved.positionalArgs = true;
  return resolved;
}
