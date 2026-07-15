import type { ChatMessage } from "../domain/messages/model.js";
import type { ToolSet } from "../domain/tools/types.js";
import type { StreamCallback, TurnResult } from "./chat-agent.js";
import type { ConversationEventLog } from "../domain/events/log.js";
import type { CallableRegistry } from "../domain/runtime/rpc/callable.js";
import type { IdSource } from "../kernel/ids.js";
import type { StateOrigin } from "./agent.js";

/**
 * Capability interfaces for transports/drivers (ADR-0002; ISSUE-030).
 *
 * A transport requires exactly the intersection it speaks — never a concrete
 * agent class (a class with `private` fields is nominal and would reject
 * byte-identical userland compositions). The full `cf_agent_*` WS adapter
 * types against `ConversationApi & ApprovalApi & RecoveryIntrospection &
 * AgentCoreApi` (see `ChatTransportAgent` in the WS adapter); a bare
 * HTTP/SSE turn driver needs only `ConversationApi`.
 *
 * Callers are transports/drivers (WS chat adapter, CLI demo, delegation
 * relay), never end users. Do NOT name anything here `ConversationSurface` —
 * "Surface" is Channels' synonym in the context map.
 */

/** The conversing essence — implemented by ChatAgent (and any userland equivalent). */
export interface ConversationApi {
  chat(
    input: string | ChatMessage[],
    callback?: StreamCallback,
    opts?: { channel?: string; requestId?: string; clientTools?: ToolSet },
  ): Promise<TurnResult>;
  cancelChat(requestId: string, reason?: string): boolean;
  applyToolResult(args: { toolCallId: string; output: unknown; isError?: boolean }): Promise<void>;
  history(): Promise<ChatMessage[]>;
  clearMessages(): Promise<void>;
}

/** HITL opinion extension — implemented by Think (or any composition adopting the opinion). */
export interface ApprovalApi {
  resolveApproval(args: {
    toolCallId?: string;
    executionId?: string;
    approved: boolean;
    reason?: string;
  }): Promise<void>;
}

/** Recovery-policy introspection opinion extension — implemented by Think. */
export interface RecoveryIntrospection {
  isRecovering(): boolean;
  activeTurn(): { requestId: string; startOffset: number } | null;
  pendingChatTerminal(): { requestId: string; body: string } | null;
}

/**
 * The Agent-level substrate slice a transport consumes: events, state
 * sync, RPC/identity — everything below the conversation-layer opinions
 * above. `Agent implements AgentCoreApi` must hold (compile-checked).
 *
 * Deliberately COARSE (ISSUE-030 W-A, maintainer-approved) rather than three
 * fine-grained interfaces (`EventLogSource`, `StateSyncApi`, `RpcApi`): there
 * is exactly one consumer today (the WS chat adapter), and it uses the whole
 * slice. Split into finer interfaces later if a transport ever needs only a
 * subset — until then, one coarse interface is less ceremony than three for
 * a single caller.
 */
export interface AgentCoreApi {
  /** The agent's single outbound port. Adapters subscribe (from an offset, or "live"). */
  events(): ConversationEventLog;
  readonly state: unknown;
  /** `origin` flows into the published `state:changed` event; defaults to `{ kind: "server" }`. */
  setState(next: unknown, origin?: StateOrigin): void;
  /** What the identity frame used to carry, minus the transport-supplied connectionId. */
  identity(): { className: string; name: string };
  /** The RPC dispatch surface itself; adapters call `.dispatch(request, respond)`. */
  callables(): CallableRegistry;
  readonly ids: IdSource;
}
