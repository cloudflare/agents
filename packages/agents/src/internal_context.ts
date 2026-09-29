export {
  __DO_NOT_USE_WILL_BREAK__agentContext,
  type AgentContextStore,
  type CurrentAgentContext
} from "./lifecycle/current-agent";

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
