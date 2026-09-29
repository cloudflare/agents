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
  /**
   * Re-extend every lock this adapter acquired, by its original TTL, every
   * third of that TTL until it is released. The Chat SDK takes a fixed 30
   * second thread lock and never extends it while a handler runs, so a handler
   * that outlives it lets the next message take a second lock and run
   * concurrently. A lock held by an isolate that dies stops being extended and
   * expires on its own TTL.
   * @default false
   */
  lockHeartbeat?: boolean;
}
