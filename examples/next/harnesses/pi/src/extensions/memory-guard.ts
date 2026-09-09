import type { PiExtensionApi } from "../harness/types";

/** Memory names starting with this are reserved for the host. */
const RESERVED_PREFIX = "_";

/**
 * Refuse writes to reserved memory names.
 *
 * A pi extension is a plain function over pi's own `ExtensionAPI`: it
 * subscribes to `tool_call`, which the harness bridges from pi's `before_tool`
 * hook, and blocking here blocks the tool before it runs. Extensions are
 * process-local and re-loaded on every isolate wake, so this registration runs
 * again after every eviction.
 */
export function memoryGuard(pi: PiExtensionApi): void {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "remember") return undefined;
    const key = (event.input as { readonly key?: unknown }).key;
    if (typeof key !== "string" || !key.startsWith(RESERVED_PREFIX)) {
      return undefined;
    }
    return { block: true, reason: "Memory names cannot start with _." };
  });
}
