import type { Clock } from "../../ports/clock.js";
import type { ChannelPolicy } from "../channels/channels.js";
import type { Session } from "../session/session.js";
import type { SkillRegistry } from "../skills/skills.js";
import { assembleTools, type AssembledTools, type ToolHooks, type ToolSources } from "../tools/registry.js";
import type { ToolSet } from "../tools/types.js";

/**
 * TurnAssembly (audit 26 extraction 3): the merge-order/prompt-concatenation
 * algorithm Think ran inline as `buildAssembly`. Pulled out as a directly
 * testable pure-ish function — the only side effects are the (idempotent,
 * cached) reads on `session`/`skills`.
 */
export interface AssemblyInputs {
  session: Session;
  skills: SkillRegistry;
  policy: ChannelPolicy;
  workspaceTools?: ToolSet;
  fetchTools?: ToolSet;
  actions: ToolSet;
  userTools: ToolSet;
  clientTools?: ToolSet;
  hooks?: ToolHooks;
  clock: Clock;
}

/**
 * Prompt order (unchanged from doc 08/23): frozen session prompt -> channel
 * instructions -> skills catalog -> capability block, joined by blank lines,
 * empty segments dropped. Tool merge order unchanged (doc 08): builtin <
 * external < actions < user, then client tools fill in only where they don't
 * collide with a server-sourced name.
 */
export async function assembleTurn(inputs: AssemblyInputs): Promise<{ system: string; tools: AssembledTools }> {
  const builtin: ToolSet = {
    ...(inputs.workspaceTools ?? {}),
    ...(await inputs.session.tools()),
    ...inputs.skills.tools(),
  };

  const sources: ToolSources = {
    builtin,
    external: inputs.fetchTools ?? {},
    actions: inputs.actions,
    user: inputs.userTools,
    client: inputs.clientTools ?? {},
  };

  const tools = assembleTools(sources, {
    ...(inputs.hooks ? { hooks: inputs.hooks } : {}),
    ...(inputs.policy.toolFilter ? { filter: inputs.policy.toolFilter } : {}),
    clock: inputs.clock,
  });

  const baseSystemPrompt = await inputs.session.freezeSystemPrompt();
  const catalog = inputs.skills.catalogBlock();
  const capBlock = tools.capabilityBlock();
  const system = [baseSystemPrompt, inputs.policy.instructions, catalog, capBlock]
    .filter((s): s is string => Boolean(s))
    .join("\n\n");

  return { system, tools };
}
