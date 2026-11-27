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
 * Set a tool, marked safe to run again after an interruption when its name
 * is in `rerun`: a read that changes nothing. Other tools cut off by a
 * reset are reported to the model as interrupted.
 *
 * @internal
 */
export function setTool<T extends object>(
  tools: { set(name: string, tool: T): unknown },
  name: string,
  tool: T,
  rerun: ReadonlySet<string>
): void {
  tools.set(name, rerun.has(name) ? { ...tool, recovery: "rerun" } : tool);
}

/** The workspace tools that only read. */
const WORKSPACE_READS = new Set(["read", "ls", "grep", "find"]);

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
        setTool(tools, name, tool, WORKSPACE_READS);
      }
    });
}
