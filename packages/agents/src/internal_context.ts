import { AsyncLocalStorage } from "node:async_hooks";
import type { Connection } from "partyserver";

export type AgentEmail = {
  from: string;
  to: string;
  getRaw: () => Promise<Uint8Array>;
  headers: Headers;
  rawSize: number;
  setReject: (reason: string) => void;
  forward: (rcptTo: string, headers?: Headers) => Promise<EmailSendResult>;
  reply: (options: {
    from: string;
    to: string;
    raw: string;
  }) => Promise<EmailSendResult>;
};

export type AgentContextStore = {
  // Using unknown to avoid circular dependency with Agent
  agent: unknown;
  connection: Connection | undefined;
  request: Request | undefined;
  email: AgentEmail | undefined;
};

export const agentContext = new AsyncLocalStorage<AgentContextStore>();
