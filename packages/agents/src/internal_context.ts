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
  /** @internal Indicates email was routed via createSecureReplyEmailResolver */
  _secureRouted?: boolean;
};

export type AgentContextStore = {
  // Using unknown to avoid circular dependency with Agent
  agent: unknown;
  connection: Connection | undefined;
  request: Request | undefined;
  email: AgentEmail | undefined;
};

/**
 * @internal — This is an internal implementation detail.
 * Importing or relying on this symbol **will** break your code in a future release.
 */
export const __DO_NOT_USE_WILL_BREAK__agentContext =
  new AsyncLocalStorage<AgentContextStore>();
