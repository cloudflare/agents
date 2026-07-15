import type { ChatMessage } from "../domain/messages/model.js";
import type { ToolSet } from "../domain/tools/types.js";
import type { StreamCallback, TurnResult } from "./chat-agent.js";

/**
 * Capability interfaces for transports/drivers (ADR-0002; ISSUE-030).
 *
 * A transport requires exactly the intersection it speaks — never a concrete
 * agent class (a class with `private` fields is nominal and would reject
 * byte-identical userland compositions). The full `cf_agent_*` WS adapter
 * types against `ConversationApi & ApprovalApi & RecoveryIntrospection`; a
 * bare HTTP/SSE turn driver needs only `ConversationApi`.
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
