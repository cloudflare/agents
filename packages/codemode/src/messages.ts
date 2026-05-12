/**
 * Typed postMessage protocol for host ↔ iframe sandbox communication.
 *
 * Messages flow in two directions:
 * - Sandbox → Host: tool calls and execution results
 * - Host → Sandbox: tool results and execute requests
 */

import type { ExecuteResult } from "./executor-types";

// -- Helpers --

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// -- Sandbox → Host messages --

export interface ToolCallMessage {
  type: "tool-call";
  nonce: string;
  id: number;
  provider: string;
  name: string;
  args: unknown;
}

export interface ExecutionResultMessage {
  type: "execution-result";
  nonce: string;
  result: ExecuteResult;
}

export interface SandboxReadyMessage {
  type: "sandbox-ready";
}

// -- Host → Sandbox messages --

export interface ToolResultSuccessMessage {
  type: "tool-result";
  nonce: string;
  id: number;
  result: unknown;
}

export interface ToolResultErrorMessage {
  type: "tool-result";
  nonce: string;
  id: number;
  error: string;
}

export interface ExecuteRequestMessage {
  type: "execute-request";
  nonce: string;
  code: string;
  providers: { name: string; positionalArgs?: boolean }[];
}

// -- Type guards --

export function isSandboxReadyMessage(
  data: unknown
): data is SandboxReadyMessage {
  return isRecord(data) && data.type === "sandbox-ready";
}

export function isToolCallMessage(data: unknown): data is ToolCallMessage {
  return (
    isRecord(data) &&
    data.type === "tool-call" &&
    typeof data.nonce === "string" &&
    typeof data.id === "number" &&
    typeof data.provider === "string" &&
    typeof data.name === "string"
  );
}

export function isExecutionResultMessage(
  data: unknown
): data is ExecutionResultMessage {
  if (!isRecord(data)) return false;
  if (data.type !== "execution-result") return false;
  if (typeof data.nonce !== "string") return false;
  if (typeof data.result !== "object" || data.result === null) return false;
  return true;
}

export function isExecuteRequestMessageShape(
  data: unknown
): data is ExecuteRequestMessage {
  return (
    isRecord(data) &&
    data.type === "execute-request" &&
    typeof data.nonce === "string" &&
    typeof data.code === "string" &&
    Array.isArray(data.providers) &&
    data.providers.every(
      (provider) =>
        isRecord(provider) &&
        typeof provider.name === "string" &&
        (provider.positionalArgs === undefined ||
          typeof provider.positionalArgs === "boolean")
    )
  );
}
