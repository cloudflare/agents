import type { AgentMiddleware, MWContext } from "../types";
import { ModelPlanBuilder } from "../middleware/plan";

export async function step(
  mws: AgentMiddleware[],
  ctx: MWContext
): Promise<void> {
  // let MWs run any init logic for tick
  for (const m of mws) await m.onTick?.(ctx);

  // build model req
  const plan = new ModelPlanBuilder(ctx.agent);
  for (const m of mws) await m.beforeModel?.(ctx, plan); // lets MWs add sys prompt, tool defs, etc.

  if (ctx.agent.isPaused) return;

  // invoke model
  const req = plan.build();
  const res = await ctx.provider.invoke(req, {});

  // let MWs react to the model result
  for (const m of mws) await m.onModelResult?.(ctx, res);

  // Should we set this before or after the MWs?
  ctx.store.appendMessages([res.message]);

  const newToolCalls =
    res.message && "toolCalls" in res.message && res.message.toolCalls
      ? res.message.toolCalls
      : [];
  ctx.store.setPendingToolCalls(newToolCalls);
}
