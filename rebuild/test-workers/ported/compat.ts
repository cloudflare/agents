/**
 * Compat shim for ported original tests (audit 29 §2).
 *
 * Ported test files re-point their `agents` / `partyserver` /
 * `@cloudflare/think` imports at this single module, which maps each name
 * onto the rebuilt surface. Grow it per ported file — never let a ported
 * test import rebuild internals directly (the shim IS the documented compat
 * surface).
 */
import type { DurableObjectStub } from "@cloudflare/workers-types";
import {
  getAgentByName as rebuiltGetAgentByName,
  routeAgentRequest,
} from "../../src/adapters/cloudflare/routing.js";
import type { TurnResult as RebuiltTurnResult } from "../../src/app/think.js";
import {
  defaultContextOverflowClassifier as rebuiltDefaultContextOverflowClassifier
} from "../../src/domain/reliability/recovery/overflow.js";

export { routeAgentRequest };

/** Original `agents` export. The rebuilt version is async (it __init's the name). */
export function getAgentByName<T extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<T>,
  name: string
): Promise<DurableObjectStub<T>> {
  return rebuiltGetAgentByName(
    namespace as unknown as DurableObjectNamespace,
    name
  ) as Promise<DurableObjectStub<T>>;
}

/** partyserver's older equivalent — same semantics for test purposes. */
export const getServerByName = getAgentByName;

export enum MessageType {
  CF_AGENT_IDENTITY = "cf_agent_identity",
  CF_AGENT_STATE = "cf_agent_state",
  CF_AGENT_MCP_SERVERS = "cf_agent_mcp_servers",
  RPC = "rpc"
}

export function defaultContextOverflowClassifier(
  error: unknown
): "context_overflow" | undefined {
  return rebuiltDefaultContextOverflowClassifier(error) === "context_overflow"
    ? "context_overflow"
    : undefined;
}

/**
 * `agents/observability` subscribe. Not bridged yet (ISSUE-009) — ported
 * tests that assert observability events fail here with a clear triage
 * signal rather than a confusing frame mismatch.
 */
export type ObservabilityEvent = {
  type?: string;
  name?: string;
  payload: Record<string, unknown> & { toolCallIds?: string[] };
  [key: string]: unknown;
};

export function subscribe(
  _channel: string,
  _callback: (event: ObservabilityEvent) => void
): () => void {
  throw new Error("observability bridge not implemented — ISSUE-009 (triage: missing-feature)");
}

/**
 * Type re-exports the original test files reference from the think package.
 * Map to rebuilt equivalents as ports need them; add aliases here, not casts
 * in test files.
 */
export type {
  TurnResult,
  StreamCallback,
  ChatErrorContext,
  SessionBuilder,
} from "../../src/app/think.js";
export type { ChatMessage as RebuiltChatMessage } from "../../src/domain/messages/model.js";
export type ChatResponseResult = {
  requestId: string;
  status: "completed" | "error" | "interrupted";
  continuation: boolean;
  message?: import("../../src/domain/messages/model.js").ChatMessage;
  attachments?: Array<Record<string, unknown>>;
};
export type SaveMessagesResult = RebuiltTurnResult & {
  status?: "completed" | "error" | "aborted" | "skipped" | string;
  continuation?: boolean;
};
export { Think } from "../../src/app/think.js";
export { action } from "../../src/domain/actions/actions.js";
export type { Action } from "../../src/domain/actions/actions.js";
export { callable } from "../../src/domain/runtime/rpc/callable.js";
export { tool } from "../../src/domain/tools/types.js";
export type { AgentHost } from "../../src/app/agent.js";
export { hostAgent } from "../../src/adapters/cloudflare/shell.js";
export type { ChatMessage, MessagePart, ToolPart } from "../../src/domain/messages/model.js";
export type { ModelChunk, ModelClient, ModelRequest } from "../../src/ports/model.js";
export type { ToolSet } from "../../src/domain/tools/types.js";

/** Convenience for fixtures: typed stub with the shell's RPC surface. */
export type AgentStub = DurableObjectStub & {
  __call<T = unknown>(method: string, args: unknown[]): Promise<T>;
  __init(init: { name: string }): Promise<void>;
  __destroy(): Promise<void>;
};
