/**
 * The workspace tools as an extension on ThinkHarness's core: Computer's
 * AI SDK tools over a Workspace, the same call Think makes for every turn.
 *
 * @internal Not exported from any entry point.
 */
import { createAITools } from "@cloudflare/computer/tools/ai-sdk";
import type { ThinkWorkspace } from "../../workspace-files";
import type { ThinkHarnessOptions } from "agents/harness/think";

/** An extension, as ThinkHarness's `extensions` option takes it. @internal */
export type ThinkExtension = NonNullable<
  ThinkHarnessOptions["extensions"]
>[number]["extension"];

/**
 * Offer the workspace's tools: file reads and writes, search and, when the
 * workspace has execution backends, `exec`. The workspace is read when the
 * tools are built, so a host may assign it after construction.
 *
 * @internal
 */
export function workspaceExtension(
  workspace: () => ThinkWorkspace
): ThinkExtension {
  return (ctx) =>
    ctx.tools.transform((tools) => {
      for (const [name, tool] of Object.entries(
        createAITools({ workspace: workspace() })
      )) {
        tools.set(name, tool);
      }
    });
}
