/**
 * Shared constants and types used by both the AI SDK (`./ai`) and
 * TanStack AI (`./tanstack-ai`) entry points.
 *
 * No dependency on `ai`, `@tanstack/ai`, or `zod`.
 */

import type { Executor, ToolProvider, ToolProviderTools } from "./executor";

/**
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use `exec` from `@cloudflare/computer`, with tools imported from `ws:tools`.
 * See https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export const DEFAULT_DESCRIPTION = `Execute code to achieve a goal.

Available:
{{types}}

Write an async arrow function in JavaScript that returns the result.
Do NOT use TypeScript syntax — no type annotations, interfaces, or generics.
Do NOT define named functions then call them — just write the arrow function body directly.

Example: async () => { const r = await codemode.searchWeb({ query: "test" }); return r; }`;

/**
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use `exec` from `@cloudflare/computer`, with tools imported from `ws:tools`.
 * See https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export interface CreateCodeToolOptions {
  tools: ToolProviderTools | ToolProvider[];
  executor: Executor;
  /**
   * Custom tool description. Use {{types}} as a placeholder for the generated type definitions.
   */
  description?: string;
}

/**
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use `exec` from `@cloudflare/computer`, with tools imported from `ws:tools`.
 * See https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export type CodeInput = { code: string };
/**
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use `exec` from `@cloudflare/computer`, with tools imported from `ws:tools`.
 * See https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export type CodeOutput = { result: unknown; logs?: string[] };

/**
 * Check if the tools option is an array of ToolProviders.
 * A plain ToolSet/ToolDescriptors is a Record (not an array).
 */
function isToolProviderArray(
  tools: ToolProviderTools | ToolProvider[]
): tools is ToolProvider[] {
  return Array.isArray(tools);
}

/**
 * Normalize the tools option into a list of ToolProviders.
 * Raw ToolSet/ToolDescriptors are wrapped as a single default provider.
 *
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use `exec` from `@cloudflare/computer`, with tools imported from `ws:tools`.
 * See https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
export function normalizeProviders(
  tools: ToolProviderTools | ToolProvider[]
): ToolProvider[] {
  if (isToolProviderArray(tools)) {
    return tools;
  }
  return [{ tools }];
}
