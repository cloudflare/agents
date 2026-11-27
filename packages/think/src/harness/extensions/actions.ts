/**
 * The agent's actions (`getActions()`) as an extension on ThinkHarness's
 * core: each action is a tool. An approval-gated or durable-pause action
 * asks for approval, so its call waits in the transcript until it is
 * decided; the approved call runs through the action ledger in its tool
 * step.
 *
 * @internal Not exported from any entry point.
 */
import { compileActionTools, type ActionToolHost } from "../../action-tools";
import type { Action, CompiledActionMetadata } from "../../actions";
import type { ThinkExtension } from "./workspace";

/**
 * Offer `actions()` as tools, each turn. `metadata` is refilled with each
 * approval-gated action's summary, permissions and risk, for listing.
 *
 * @internal
 */
export function actionsExtension(
  actions: () => Record<string, Action> | Promise<Record<string, Action>>,
  host: ActionToolHost,
  metadata: Map<string, CompiledActionMetadata>
): ThinkExtension {
  return (ctx) =>
    ctx.tools.transform(async (tools) => {
      metadata.clear();
      for (const [name, tool] of Object.entries(
        compileActionTools(await actions(), host, metadata)
      )) {
        tools.set(name, tool);
      }
    });
}
