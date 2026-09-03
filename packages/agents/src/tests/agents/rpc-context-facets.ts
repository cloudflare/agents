import { Agent, getCurrentAgent } from "../../index.ts";
import type { AgentCaller } from "../../index.ts";

/** What a facet-tree member observed for one contextual call. */
export type FacetObservedCall = {
  readonly label: string;
  readonly caller: AgentCaller | undefined;
};

/** Shared recorder: every class in the tree records who called `ping`. */
class RecordingAgent extends Agent {
  readonly observed: FacetObservedCall[] = [];

  async ping(label: string): Promise<string> {
    this.observed.push({ label, caller: getCurrentAgent().caller });
    return `pong:${label}`;
  }

  async observedCalls(): Promise<FacetObservedCall[]> {
    return this.observed;
  }
}

/** Grandchild facet: calls its facet parent through the root bridge. */
export class RpcContextGrandchildAgent extends RecordingAgent {
  async callParent(): Promise<string> {
    const parent = await this.parentAgent(RpcContextChildAgent);
    return parent.ping("from-grandchild");
  }
}

/** Child facet: calls its top-level parent, and spawns a grandchild. */
export class RpcContextChildAgent extends RecordingAgent {
  async callParent(): Promise<string> {
    const parent = await this.parentAgent(RpcContextRootAgent);
    return parent.ping("from-child");
  }

  async grandchildCallsMe(grandchildName: string): Promise<string> {
    const grandchild = await this.subAgent(
      RpcContextGrandchildAgent,
      grandchildName
    );
    return grandchild.callParent();
  }

  async grandchildPing(grandchildName: string): Promise<string> {
    const grandchild = await this.dynamicAgents.get(
      RpcContextGrandchildAgent,
      grandchildName
    );
    return grandchild.ping("from-child");
  }

  async grandchildObserved(
    grandchildName: string
  ): Promise<FacetObservedCall[]> {
    const grandchild = await this.subAgent(
      RpcContextGrandchildAgent,
      grandchildName
    );
    return grandchild.observedCalls();
  }
}

/** Top-level root of the facet tree. */
export class RpcContextRootAgent extends RecordingAgent {
  async childPing(childName: string): Promise<string> {
    const child = await this.subAgent(RpcContextChildAgent, childName);
    return child.ping("from-root");
  }

  async childObserved(childName: string): Promise<FacetObservedCall[]> {
    const child = await this.subAgent(RpcContextChildAgent, childName);
    return child.observedCalls();
  }

  async childCallsMe(childName: string): Promise<string> {
    const child = await this.subAgent(RpcContextChildAgent, childName);
    return child.callParent();
  }

  async grandchildCallsChild(
    childName: string,
    grandchildName: string
  ): Promise<string> {
    const child = await this.subAgent(RpcContextChildAgent, childName);
    return child.grandchildCallsMe(grandchildName);
  }

  async childPingsGrandchild(
    childName: string,
    grandchildName: string
  ): Promise<FacetObservedCall[]> {
    const child = await this.subAgent(RpcContextChildAgent, childName);
    await child.grandchildPing(grandchildName);
    return child.grandchildObserved(grandchildName);
  }
}
