/**
 * The fetch tools as an extension on ThinkHarness's core: the allowlisted,
 * read-only `fetch_*` tools Think offers when its `fetchTools` is set.
 *
 * @internal Not exported from any entry point.
 */
import {
  createFetchTools,
  type CreateFetchToolsOptions,
  type FetchToolEvent
} from "../../tools/fetch";
import type { ThinkWorkspace } from "../../workspace-files";
import { setTool, type ThinkExtension } from "./workspace";

/** The fetch tools that only read. */
const FETCH_READS = new Set(["fetch_url"]);

/**
 * Offer the fetch tools for `options()`, or none while it is `false`. The
 * workspace takes spilled bodies; `onEvent` observes each fetch.
 *
 * @internal
 */
export function fetchExtension(
  options: () => false | Omit<CreateFetchToolsOptions, "workspace" | "onEvent">,
  workspace: () => ThinkWorkspace,
  onEvent: (event: FetchToolEvent) => void
): ThinkExtension {
  return (ctx) =>
    ctx.tools.transform((tools) => {
      const configured = options();
      if (!configured) return;
      for (const [name, tool] of Object.entries(
        createFetchTools({ ...configured, workspace: workspace(), onEvent })
      )) {
        setTool(tools, name, tool, FETCH_READS);
      }
    });
}
