/**
 * Typed postMessage protocol for host ↔ iframe sandbox communication.
 *
 * Messages flow in two directions:
 * - Sandbox → Host: tool calls and execution results
 * - Host → Sandbox: tool results and execute requests
 */

import type { ExecuteResult } from "./executor";

// -- Helpers --

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// -- Sandbox → Host messages --

export interface ToolCallMessage {
  type: "tool-call";
  id: number;
  name: string;
  args: Record<string, unknown>;
}

export interface ExecutionResultMessage {
  type: "execution-result";
  result: ExecuteResult;
}

export interface SandboxReadyMessage {
  type: "sandbox-ready";
}

// -- Host → Sandbox messages --

export interface ToolResultSuccessMessage {
  type: "tool-result";
  id: number;
  result: unknown;
}

export interface ToolResultErrorMessage {
  type: "tool-result";
  id: number;
  error: string;
}

export interface ExecuteRequestMessage {
  type: "execute-request";
  code: string;
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
    typeof data.id === "number" &&
    typeof data.name === "string"
  );
}

export function isExecutionResultMessage(
  data: unknown
): data is ExecutionResultMessage {
  if (!isRecord(data)) return false;
  if (data.type !== "execution-result") return false;
  if (typeof data.result !== "object" || data.result === null) return false;
  return true;
}
