/**
 * Expose V8's `gc()` inside workerd so memory tests can force a full
 * collection. Miniflare reads `MINIFLARE_WORKERD_V8_FLAGS` when it starts
 * workerd, so call this from a Workers test project's Vitest config.
 */
export function exposeWorkerdGC(): void {
  const flags = process.env.MINIFLARE_WORKERD_V8_FLAGS?.split(" ") ?? [];
  if (flags.includes("--expose-gc")) return;
  process.env.MINIFLARE_WORKERD_V8_FLAGS = [...flags, "--expose-gc"]
    .filter(Boolean)
    .join(" ");
}
