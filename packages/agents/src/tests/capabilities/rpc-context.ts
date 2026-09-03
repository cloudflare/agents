import { DurableObject } from "cloudflare:workers";
import { getAgentByName } from "../../agent-routing";
import { getCurrentAgent, Lifecycle } from "../../lifecycle";
import type { AgentCaller } from "../../lifecycle/current-agent";

/** What a plain Lifecycle Object observed for one contextual call. */
export type LifecycleObservedCall = {
  readonly caller: AgentCaller | undefined;
  readonly hostIsSelf: boolean;
  readonly started: boolean;
};

/**
 * A Lifecycle Object that does not extend Agent. Acts as both callee (records
 * who called `ping`) and caller (`callPeer` resolves another instance through
 * `getAgentByName`), so the contextual stub can be exercised end to end
 * without any Agent involved.
 */
export class RpcContextLifecycleObject extends DurableObject<Cloudflare.Env> {
  readonly #observed: LifecycleObservedCall[] = [];
  #started = false;

  readonly lifecycle = Lifecycle.install(this).use({
    onStart: () => {
      this.#started = true;
    }
  });

  async ping(label: string): Promise<string> {
    const { agent, caller } = getCurrentAgent();
    this.#observed.push({
      caller,
      hostIsSelf: agent === this,
      started: this.#started
    });
    return `pong:${label}`;
  }

  async observedCalls(): Promise<LifecycleObservedCall[]> {
    return this.#observed;
  }

  async callPeer(
    peerName: string,
    context?: Record<string, string | number | boolean>
  ): Promise<string> {
    const peer = await getAgentByName(
      this.env.RpcContextLifecycleObject,
      peerName,
      { context }
    );
    return peer.ping("from-lifecycle-object");
  }

  async callAgent(agentName: string): Promise<string> {
    const agent = await getAgentByName(
      this.env.TestRpcContextCalleeAgent,
      agentName
    );
    return agent.ping("from-lifecycle-object");
  }
}
