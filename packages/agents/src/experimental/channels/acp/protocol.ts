/**
 * The subset of the Agent Client Protocol (stable v1) the ACP channel
 * speaks, and the JSON-RPC 2.0 envelope it travels in. Hand-written from
 * the published schema so `agents` takes no ACP dependency; field names
 * match `@agentclientprotocol/sdk`.
 *
 * Over a WebSocket, each text frame is one JSON-RPC message, as in the SDK's
 * `createWebSocketStream`.
 */
import type { Json, JsonObject } from "../protocol";

export const ACP_PROTOCOL_VERSION = 1;

// ── JSON-RPC ─────────────────────────────────────────────────────────────

export type RpcId = string | number | null;

export type RpcRequest = {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: Json;
};

export type RpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Json;
};

export type RpcResponse =
  | { jsonrpc: "2.0"; id: RpcId; result: Json }
  | {
      jsonrpc: "2.0";
      id: RpcId;
      error: { code: number; message: string; data?: Json };
    };

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export const RpcError = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** ACP: authentication required. */
  authRequired: -32000,
  /** ACP: the resource, such as a session, does not exist. */
  resourceNotFound: -32002
} as const;

/** A JSON-RPC message, or undefined for anything else. */
export function parseRpcMessage(text: string): RpcMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.jsonrpc !== "2.0") return undefined;
  const hasId =
    "id" in value &&
    (typeof value.id === "string" ||
      typeof value.id === "number" ||
      value.id === null);
  if (typeof value.method === "string") {
    // SAFETY: checked above; params are validated per method.
    return value as unknown as RpcRequest | RpcNotification;
  }
  if (hasId && ("result" in value || isRecord(value.error))) {
    // SAFETY: checked above.
    return value as unknown as RpcResponse;
  }
  return undefined;
}

export function isRequest(message: RpcMessage): message is RpcRequest {
  return "method" in message && "id" in message;
}

export function isNotification(
  message: RpcMessage
): message is RpcNotification {
  return "method" in message && !("id" in message);
}

export function result(id: RpcId, value: Json): RpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}

export function failure(id: RpcId, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Content ──────────────────────────────────────────────────────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string }
  | { type: "audio"; data: string; mimeType: string }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      title?: string;
      description?: string;
      mimeType?: string;
    }
  | {
      type: "resource";
      resource:
        | { uri: string; text: string; mimeType?: string }
        | { uri: string; blob: string; mimeType?: string };
    };

// ── Session updates ──────────────────────────────────────────────────────

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolCallContent = {
  type: "content";
  content: ContentBlock;
};

export type ToolCallFields = {
  toolCallId: string;
  title?: string;
  kind?: "other";
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  rawInput?: Json;
  rawOutput?: Json;
};

export type SessionUpdate =
  | {
      sessionUpdate:
        | "user_message_chunk"
        | "agent_message_chunk"
        | "agent_thought_chunk";
      content: ContentBlock;
      messageId?: string;
    }
  | (ToolCallFields & { sessionUpdate: "tool_call"; title: string })
  | (ToolCallFields & { sessionUpdate: "tool_call_update" });

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

// ── Agent methods ────────────────────────────────────────────────────────

export type AgentInfo = { name: string; title?: string; version: string };

export type InitializeResponse = {
  protocolVersion: number;
  agentCapabilities: {
    loadSession: boolean;
    promptCapabilities: {
      image: boolean;
      audio: boolean;
      embeddedContext: boolean;
    };
    mcpCapabilities: { http: boolean; sse: boolean };
    sessionCapabilities: {
      list?: JsonObject;
      resume?: JsonObject;
      close?: JsonObject;
      fork?: JsonObject;
    };
  };
  authMethods: [];
  agentInfo?: AgentInfo;
};

export type SessionInfo = {
  sessionId: string;
  cwd: string;
  title?: string;
};

export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export type RequestPermissionParams = {
  sessionId: string;
  toolCall: ToolCallFields;
  options: { optionId: string; name: string; kind: PermissionOptionKind }[];
};
