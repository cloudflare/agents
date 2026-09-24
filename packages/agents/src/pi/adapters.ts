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
  return tools as unknown as UpstreamAgentHarnessTool<ToolContext>[];
}

export function asUpstreamResources(resources: PiResources): UpstreamResources {
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
    runningTools: operation.runningTools
      .filter((tool) => tool.status === "running")
      .map((tool) => ({
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        arguments: tool.args as PiJson,
        partial: tool.result && projectToolResult(tool.result)
      })),
    retry: operation.retry,
    deferred: operation.deferred?.handle
  };
}
