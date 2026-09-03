import { Agent, getAgentByName, getCurrentAgent } from "../../index.ts";
import type { AgentCaller } from "../../index.ts";

/** What a callee observed for one contextual RPC call. */
export type ObservedCall = {
  readonly method: string;
  readonly caller: AgentCaller | undefined;
  /** Whether `getCurrentAgent().agent` was the callee itself. */
  readonly agentIsSelf: boolean;
};

/** Callee side: records who called it. */
export class TestRpcContextCalleeAgent extends Agent {
  observed: ObservedCall[] = [];

  async ping(label: string): Promise<string> {
    const { agent, caller } = getCurrentAgent();
    this.observed.push({ method: "ping", caller, agentIsSelf: agent === this });
    return `pong:${label}`;
  }

  async observedCalls(): Promise<ObservedCall[]> {
    return this.observed;
  }

  async throwing(): Promise<never> {
    throw new Error("callee failed on purpose");
  }
}

/** Caller side: an Agent calling another Agent through `getAgentByName`. */
export class TestRpcContextCallerAgent extends Agent {
  async callPeer(
    peerName: string,
    context?: Record<string, string | number | boolean>
  ): Promise<string> {
    const peer = await getAgentByName(
      this.env.TestRpcContextCalleeAgent,
      peerName,
      { context }
    );
    return peer.ping("from-agent");
  }

  async callLifecycleObject(name: string): Promise<string> {
    const peer = await getAgentByName(this.env.RpcContextLifecycleObject, name);
    return peer.ping("from-agent");
  }
}
