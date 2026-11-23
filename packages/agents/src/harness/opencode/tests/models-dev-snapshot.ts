/**
 * OpenCode inlines models.dev's catalog as one 8 MB string, too large for
 * the message that carries a module into the test runtime. These tests turn
 * catalog fetches off and use only the Cloudflare provider, so an empty
 * catalog stands in. If OpenCode's build changes shape, fail here rather
 * than at the module transfer.
 */

const MARKER = "// src/models-dev/snapshot.txt";
const LITERAL =
  /(\/\/ src\/models-dev\/snapshot\.txt\nvar snapshot_default = )'.*';/;

/**
 * No other `@opencode/core` module comes near this size (the largest is
 * under 100 KB at 2.4.0), so a module this large without the marker is the
 * catalog under a new marker.
 */
export const OVERSIZED_MODULE_BYTES = 1_000_000;

/** Vite `transform` body: the module with an empty catalog, or null. */
export function stubModelsDevSnapshot(code: string, id: string): string | null {
  if (!id.includes("/@opencode/core/dist/")) return null;
  if (!code.includes(MARKER)) {
    if (code.length > OVERSIZED_MODULE_BYTES) {
      throw new Error(
        `empty-models-dev-snapshot: ${id} is ${code.length} bytes but has no "${MARKER}" marker; update the pattern for this @opencode/core build`
      );
    }
    return null;
  }
  const stubbed = code.replace(LITERAL, "$1'{}';");
  if (stubbed === code) {
    throw new Error(
      `empty-models-dev-snapshot: no snapshot literal to replace in ${id}; update the pattern for this @opencode/core build`
    );
  }
  return stubbed;
}
