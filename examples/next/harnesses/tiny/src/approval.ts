/** Durable tool authorization through the owning turn Task. */
import type { TaskStep } from "agents/tasks";
import type { ApprovalDecision, PendingApproval } from "./protocol";
import type { PendingCall } from "./turn";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export type ApprovalMode =
  | { readonly kind: "auto" }
  | { readonly kind: "interactive"; readonly timeoutMs?: number }
  | {
      readonly kind: "delegated";
      readonly decide: (call: PendingCall) => Promise<ApprovalDecision>;
    };

export function authorizationId(turnId: string, callKey: string): string {
  return `${turnId}:${callKey}`;
}

export function authorizationEvent(approvalId: string): string {
  return `authorization:${approvalId}`;
}

/** Wait for the external authorization payload in the Task journal. */
export async function awaitApproval(
  mode: ApprovalMode,
  call: PendingCall,
  turnId: string,
  step: TaskStep
): Promise<ApprovalDecision> {
  if (mode.kind === "auto") return { approved: true };
  if (mode.kind === "delegated") return mode.decide(call);

  const approvalId = authorizationId(turnId, call.callKey);
  return step.waitForEvent<ApprovalDecision>(`authorize:${call.callKey}`, {
    type: authorizationEvent(approvalId),
    metadata: {
      kind: "tool-authorization",
      approvalId,
      turnId,
      toolName: call.name,
      input: call.input,
      requestedAt: Date.now()
    },
    timeout: mode.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  });
}

/** Project public Task wait metadata into the authorization UI shape. */
export function pendingApprovalFromMetadata(
  metadata: Record<string, unknown> | undefined
): PendingApproval | null {
  if (metadata?.kind !== "tool-authorization") return null;
  const { approvalId, turnId, toolName, input, requestedAt } = metadata;
  if (
    typeof approvalId !== "string" ||
    typeof turnId !== "string" ||
    typeof toolName !== "string" ||
    typeof requestedAt !== "number" ||
    !isJson(input)
  ) {
    return null;
  }
  return { approvalId, turnId, toolName, input, requestedAt };
}

function isJson(value: unknown): value is PendingApproval["input"] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJson);
}
