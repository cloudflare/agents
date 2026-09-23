/**
 * Pure adapters between this example's public `Pi*` types and the upstream
 * pi types they project.
 *
 * None of these touch harness state. They exist because the example keeps a
 * stable surface of its own rather than re-exporting pi's types directly, so
 * a pi release that changes an internal shape is absorbed here instead of
 * rippling through the capability.
 */

import {
  BACKGROUND_CONTEXT,
  type AgentHarnessTool as UpstreamAgentHarnessTool,
  type Context as UpstreamContext,
  type LaneSnapshot,
  type OperationRequest as UpstreamOperationRequest,
  type OperationResultRecord,
  type Resources as UpstreamResources,
  type Skill as UpstreamSkill
} from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { projectAgentMessage, projectToolResult } from "./messages";
import type { PiRunResult } from "./machine";
import type {
  PiContext,
  PiJson,
  PiMessageInput,
  PiOperationKind,
  PiOperationRequest,
  PiOperationResult,
  PiOperationStatus,
  PiResources,
  PiTool
} from "./types";

export function asUpstreamContext(
  context: PiContext | undefined
): UpstreamContext {
  // SAFETY: PiContext is the public structural projection of Chord Context.
  return (context ?? BACKGROUND_CONTEXT) as UpstreamContext;
}

export function asUpstreamRequest(
  request: PiOperationRequest,
  operationId: string
): UpstreamOperationRequest {
  switch (request.kind) {
    case "prompt":
      return {
        kind: "prompt",
        operationId,
        prompt: request.prompt,
        images: request.images?.map(
          (image): ImageContent => ({ type: "image", ...image })
        )
      };
    case "skill":
      return {
        kind: "skill",
        operationId,
        name: request.name,
        additionalInstructions: request.additionalInstructions
      };
    case "prompt_template":
      return {
        kind: "prompt_template",
        operationId,
        name: request.name,
        args: request.args ? [...request.args] : undefined
      };
    case "compaction":
      return {
        kind: "compaction",
        operationId,
        customInstructions: request.customInstructions
      };
    case "navigation":
      return {
        kind: "navigation",
        operationId,
        targetId: request.targetId,
        options: {
          summarize: request.summarize,
          label: request.label,
          customInstructions: request.customInstructions
        }
      };
  }
}

export function requestKind(request: PiOperationRequest): PiOperationKind {
  switch (request.kind) {
    case "compaction":
      return "compaction";
    case "navigation":
      return "navigation";
    default:
      return "run";
  }
}

export function messageInput(input: PiMessageInput): {
  text: string;
  images: ImageContent[] | undefined;
} {
  if (typeof input === "string") return { text: input, images: undefined };
  return {
    text: input.text,
    images: input.images?.map((image) => ({ type: "image", ...image }))
  };
}

export function asUpstreamTools<ToolContext extends object | undefined>(
  tools: readonly PiTool<ToolContext>[]
): UpstreamAgentHarnessTool<ToolContext>[] {
  // SAFETY: PiTool is the public structural projection of AgentHarnessTool.
  return tools as unknown as UpstreamAgentHarnessTool<ToolContext>[];
}

export function asUpstreamResources(resources: PiResources): UpstreamResources {
  // SAFETY: PiSkill and PiPromptTemplate mirror pi's Skill and PromptTemplate.
  return {
    skills: resources.skills as UpstreamSkill[] | undefined,
    promptTemplates: resources.promptTemplates
      ? [...resources.promptTemplates]
      : undefined
  };
}

export function projectResult(
  record: OperationResultRecord
): PiOperationResult {
  return {
    operationId: record.operationId,
    kind: record.kind,
    status: record.status,
    error: record.error && {
      code: record.error.code,
      message: record.error.message
    },
    fromTipId: record.fromTipId,
    tipId: record.tipId,
    startedAt: record.startedAt,
    endedAt: record.endedAt
  };
}

/**
 * Project pi's terminal record into the machine's bounded result.
 *
 * The checkpoint keeps only the disposition; the full record and the
 * transcript stay in pi's own tables.
 */
export function projectRunResult(record: OperationResultRecord): PiRunResult {
  return {
    operationId: record.operationId,
    status: record.status,
    error: record.error && {
      code: record.error.code,
      message: record.error.message
    }
  };
}

export function operationStatus(
  operation: NonNullable<LaneSnapshot["operation"]>
): PiOperationStatus {
  const streaming = operation.streamingMessage
    ? projectAgentMessage(operation.streamingMessage, `pending:${operation.id}`)
    : undefined;
  return {
    operationId: operation.id,
    kind: operation.kind,
    status: operation.status === "aborting" ? "aborting" : "running",
    startedAt: operation.startedAt,
    streaming,
    // Pi reports both still-running and already-settled calls for the live
    // operation; only the running ones belong in its running-tool view.
    runningTools: operation.runningTools
      .filter((tool) => tool.status === "running")
      .map((tool) => ({
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        // SAFETY: pi validated these arguments against the tool schema.
        arguments: tool.args as PiJson,
        partial: tool.result && projectToolResult(tool.result)
      })),
    retry: operation.retry,
    deferred: operation.deferred?.handle
  };
}
