/**
 * A Think that cannot be constructed. The compat scoreboard runs the suite
 * against it once: a test that still passes never constructs Think, so it
 * says nothing about the harness-backed one and is left out of the score.
 */
import { Agent, type AgentContext } from "agents";

export class Think<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  static readonly CHAT_FIBER_NAME = "__cf_internal_chat_turn";

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    throw new Error("Think is absent in this run of the compat scoreboard");
  }
}
