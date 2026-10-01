/** JSON metadata carried without depending on an AI framework. */
export type ChannelJsonValue =
  | null
  | string
  | number
  | boolean
  | ChannelJsonObject
  | ChannelJsonValue[];

export type ChannelJsonObject = {
  [key: string]: ChannelJsonValue | undefined;
};

export type ChannelProviderMetadata = Record<string, ChannelJsonObject>;

type ProviderContext = {
  providerMetadata?: ChannelProviderMetadata;
};

type ToolContext = ProviderContext & {
  providerExecuted?: boolean;
  toolMetadata?: ChannelJsonObject;
  dynamic?: boolean;
};

/** Why a model stopped producing this message, not whether delivery succeeded. */
export type ChannelFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other";

/**
 * One event in a progressively generated answer.
 *
 * Simple producers may emit only `text`. Rich producers preserve message/part
 * boundaries, tool calls and results, and structured content in this same stream.
 * IDs are scoped to their message, except tool-call IDs used to correlate results.
 * A delta with an ID belongs to an explicitly started part of the same kind.
 *
 * Text-only Channels may project the answer onto text, but that projection is
 * not evidence that a client tool ran. `tool` is a presentation-only status;
 * `tool-input-available` carries an actual invocation. Only the application can
 * decide where it executes and whether a returned result permits continuation.
 * Source errors/aborts still error the ReadableStream so all Channels finalize
 * incomplete delivery. A `message-finish` does not settle pending client tools.
 */
export type ChannelChunk =
  | { type: "message-start"; messageId?: string; metadata?: unknown }
  | {
      type: "message-finish";
      finishReason?: ChannelFinishReason;
      metadata?: unknown;
    }
  | { type: "message-metadata"; metadata: unknown }
  | { type: "step-start" }
  | { type: "step-finish" }
  | ({ type: "text-start"; id: string } & ProviderContext)
  | ({ type: "text-end"; id: string } & ProviderContext)
  | ({ type: "text"; text: string; id?: string } & ProviderContext)
  | ({ type: "reasoning-start"; id: string } & ProviderContext)
  | ({ type: "reasoning-end"; id: string } & ProviderContext)
  | ({ type: "reasoning"; text: string; id?: string } & ProviderContext)
  | {
      type: "tool";
      /** Presentation-only status, not a request to execute a tool. */
      id?: string;
      name: string;
      status: "started" | "completed" | "failed";
      title?: string;
      detail?: string;
    }
  | ({
      type: "tool-input-start";
      toolCallId: string;
      toolName: string;
      title?: string;
    } & ToolContext)
  | { type: "tool-input-delta"; toolCallId: string; delta: string }
  | ({
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: unknown;
      title?: string;
    } & ToolContext)
  | ({
      type: "tool-input-error";
      toolCallId: string;
      toolName: string;
      input: unknown;
      errorText: string;
      title?: string;
    } & ToolContext)
  | ({
      type: "tool-output-available";
      toolCallId: string;
      output: unknown;
      preliminary?: boolean;
    } & ToolContext)
  | ({
      type: "tool-output-error";
      toolCallId: string;
      errorText: string;
    } & ToolContext)
  | { type: "tool-output-denied"; toolCallId: string }
  // Preserve existing chat approval output without introducing an interaction API.
  | {
      type: "tool-approval-request";
      approvalId: string;
      toolCallId: string;
      isAutomatic?: boolean;
      signature?: string;
    }
  | ({
      type: "tool-approval-response";
      approvalId: string;
      approved: boolean;
      reason?: string;
      providerExecuted?: boolean;
    } & ProviderContext)
  | ({
      type: "source";
      id?: string;
      url: string;
      title?: string;
    } & ProviderContext)
  | ({
      type: "source-document";
      id: string;
      mediaType: string;
      title: string;
      filename?: string;
    } & ProviderContext)
  | ({ type: "file"; url: string; mediaType: string } & ProviderContext)
  | ({
      type: "reasoning-file";
      url: string;
      mediaType: string;
    } & ProviderContext)
  | {
      type: "data";
      name: string;
      id?: string;
      data: unknown;
      transient?: boolean;
    }
  | ({ type: "custom"; kind: `${string}.${string}` } & ProviderContext);
