/**
 * Think's sandboxed extensions (loaded from source through
 * `extensionLoader`) as one extension on ThinkHarness's core: the tools
 * the released `ExtensionManager` offers, which run in each extension's
 * Worker.
 *
 * @internal Not exported from any entry point.
 */
import type { ExtensionManager } from "../../extensions/manager";
import type { ThinkExtension } from "./workspace";

/**
 * Offer the tools of the manager's extensions, read at each build, so an
 * extension loaded or unloaded at run time shows from the next turn.
 *
 * @internal
 */
export function sandboxedExtensions(
  manager: () => ExtensionManager | undefined
): ThinkExtension {
  return (ctx) =>
    ctx.tools.transform((tools) => {
      for (const [name, tool] of Object.entries(manager()?.getTools() ?? {})) {
        tools.set(name, tool);
      }
    });
}
