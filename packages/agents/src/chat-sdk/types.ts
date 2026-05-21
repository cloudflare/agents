import type { SubAgentClass, SubAgentStub } from "../index";
import type { ChatSdkStateAgent } from "./agent";

export interface ChatSdkStateParent {
  subAgent<T extends ChatSdkStateAgent>(
    agentClass: SubAgentClass<T>,
    name: string
  ): Promise<SubAgentStub<T>>;
}

export interface ChatSdkStateAdapterOptions {
  agent?: SubAgentClass<ChatSdkStateAgent>;
  parent?: ChatSdkStateParent;
  name?: string;
  keyShard?: (key: string) => string | undefined;
  shardKey?: (threadId: string) => string;
}
