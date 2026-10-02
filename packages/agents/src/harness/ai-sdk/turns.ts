import type { ToolSet, UIMessage, UIMessageChunk } from "ai";
import type {
  InboundEvent,
  Json,
  JsonObject,
  MessagePart,
  ResponseChunk,
  ToolPart,
  TranscriptMessage
} from "../../experimental/channels/protocol";

export type AiSdkConversionOptions = {
  /** The agent's tools. Those without `execute` run on a client. */
  tools?: ToolSet;
  /** Id of the participant whose client runs this message's client tools. */
  owner?: string;
};

function ownerOf(
  toolName: string,
  { tools, owner }: AiSdkConversionOptions
): string | undefined {
  const tool =
    tools && Object.hasOwn(tools, toolName) ? tools[toolName] : undefined;
  return tool && !tool.execute ? owner : undefined;
}

type UIPart = UIMessage["parts"][number];

// SAFETY: AI SDK values that reach these casts are JSON: tool inputs are
// parsed JSON, and outputs, metadata and data are JSON-serializable by the
// AI SDK's own contract for UI messages.
const json = (value: unknown): Json => (value ?? null) as Json;
const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null
    ? (value as JsonObject)
    : undefined;

function withMetadata<T extends object>(
  value: T,
  metadata: unknown
): T & { providerMetadata?: JsonObject } {
  const providerMetadata = object(metadata);
  return providerMetadata ? { ...value, providerMetadata } : value;
}

let warned = false;
function warnSkipped(type: string): void {
  if (warned) return;
  warned = true;
  console.warn(`Channels skipped an AI SDK part it cannot carry: "${type}"`);
}

/**
 * Convert an AI SDK UI message stream into response chunks.
 *
 * An `error` or `abort` chunk makes the iteration throw once the stream
 * ends, so a failed or aborted generation never reads as a finished one, while the stream still
 * runs to its end and its `onEnd` sees the partial message.
 */
export async function* toResponseChunks(
  stream: AsyncIterable<UIMessageChunk>,
  options: AiSdkConversionOptions = {}
): AsyncGenerator<ResponseChunk> {
  let error: Error | undefined;
  for await (const chunk of stream) {
    if (chunk.type === "error") error ??= new Error(chunk.errorText);
    if (chunk.type === "abort")
      error ??= new Error("The generation was aborted");
    const converted = toResponseChunk(chunk, options);
    if (converted) yield converted;
  }
  if (error) throw error;
}

function toResponseChunk(
  chunk: UIMessageChunk,
  options: AiSdkConversionOptions
): ResponseChunk | undefined {
  switch (chunk.type) {
    case "text-start":
    case "text-end":
    case "reasoning-start":
    case "reasoning-end":
      return withMetadata(
        { type: chunk.type, id: chunk.id },
        chunk.providerMetadata
      );
    case "text-delta":
    case "reasoning-delta":
      return { type: chunk.type, id: chunk.id, delta: chunk.delta };
    case "tool-input-start":
      return tool(chunk, options, { type: "tool-input-start" as const });
    case "tool-input-delta":
      return {
        type: "tool-input-delta",
        toolCallId: chunk.toolCallId,
        delta: chunk.inputTextDelta
      };
    case "tool-input-available":
      return withMetadata(
        tool(chunk, options, {
          type: "tool-input-available" as const,
          input: json(chunk.input)
        }),
        chunk.providerMetadata
      );
    case "tool-input-error": {
      const { owner: _owner, ...call } = tool(chunk, {}, {});
      return {
        ...call,
        type: "tool-input-error",
        input: json(chunk.input),
        errorText: chunk.errorText
      };
    }
    case "tool-approval-request":
      return {
        type: "tool-approval-request",
        toolCallId: chunk.toolCallId,
        approvalId: chunk.approvalId
      };
    case "tool-output-available":
      return {
        type: "tool-output-available",
        toolCallId: chunk.toolCallId,
        output: json(chunk.output),
        ...(chunk.preliminary && { preliminary: true }),
        ...(chunk.providerExecuted && { providerExecuted: true })
      };
    case "tool-output-error":
      return {
        type: "tool-output-error",
        toolCallId: chunk.toolCallId,
        errorText: chunk.errorText,
        ...(chunk.providerExecuted && { providerExecuted: true })
      };
    case "tool-output-denied":
      return { type: "tool-output-denied", toolCallId: chunk.toolCallId };
    case "source-url":
    case "source-document":
    case "file": {
      const { providerMetadata, ...part } = chunk;
      // SAFETY: these chunk shapes match the Channels parts field for field.
      return withMetadata(part, providerMetadata) as ResponseChunk;
    }
    case "start":
    case "finish":
      return chunk.messageMetadata === undefined
        ? undefined
        : metadata(chunk.messageMetadata);
    case "message-metadata":
      return metadata(chunk.messageMetadata);
    case "start-step":
    case "finish-step":
    case "tool-approval-response":
    case "error":
    case "abort":
      return undefined;
    default:
      if (chunk.type.startsWith("data-") && "data" in chunk) {
        return {
          type: "data",
          name: chunk.type.slice("data-".length),
          ...(chunk.id !== undefined && { id: chunk.id }),
          data: json(chunk.data),
          ...(chunk.transient && { transient: true })
        };
      }
      warnSkipped(chunk.type);
      return undefined;
  }
}

function tool<T extends object>(
  chunk: {
    toolCallId: string;
    toolName: string;
    providerExecuted?: boolean;
    dynamic?: boolean;
    title?: string;
  },
  options: AiSdkConversionOptions,
  rest: T
) {
  const owner = ownerOf(chunk.toolName, options);
  return {
    toolCallId: chunk.toolCallId,
    toolName: chunk.toolName,
    ...(owner !== undefined && { owner }),
    ...(chunk.providerExecuted && { providerExecuted: true }),
    ...(chunk.dynamic && { dynamic: true }),
    ...(chunk.title !== undefined && { title: chunk.title }),
    ...rest
  };
}

function metadata(value: unknown): ResponseChunk | undefined {
  const converted = object(value);
  return converted ? { type: "metadata", metadata: converted } : undefined;
}

/** Convert a saved AI SDK UI message into a transcript message. */
export function toTranscriptMessage(
  message: UIMessage,
  options: AiSdkConversionOptions = {}
): TranscriptMessage {
  const metadata = object(message.metadata);
  return {
    id: message.id,
    role: message.role,
    parts: message.parts.flatMap((part) => {
      const converted = toMessagePart(part, options);
      return converted ? [converted] : [];
    }),
    ...(metadata && { metadata })
  };
}

function toMessagePart(
  part: UIPart,
  options: AiSdkConversionOptions
): MessagePart | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return withMetadata(
        { type: part.type, text: part.text },
        part.providerMetadata
      );
    case "file":
    case "source-url":
    case "source-document": {
      const { providerMetadata, ...rest } = part;
      if ("providerReference" in rest) delete rest.providerReference;
      // SAFETY: these part shapes match the Channels parts field for field.
      return withMetadata(rest, providerMetadata) as MessagePart;
    }
    case "step-start":
      return undefined;
    case "dynamic-tool":
      return toToolPart(part, part.toolName, true, options);
    default:
      if (part.type.startsWith("tool-") && "toolCallId" in part) {
        return toToolPart(
          part,
          part.type.slice("tool-".length),
          false,
          options
        );
      }
      if (part.type.startsWith("data-") && "data" in part) {
        return {
          type: "data",
          name: part.type.slice("data-".length),
          ...(part.id !== undefined && { id: part.id }),
          data: json(part.data)
        };
      }
      warnSkipped(part.type);
      return undefined;
  }
}

type UIToolPart = Extract<UIPart, { toolCallId: string }>;

function toToolPart(
  part: UIToolPart,
  toolName: string,
  dynamic: boolean,
  options: AiSdkConversionOptions
): ToolPart {
  const owner = ownerOf(toolName, options);
  return withMetadata(
    {
      type: "tool",
      toolCallId: part.toolCallId,
      toolName,
      state: part.state,
      ...(part.input !== undefined && { input: json(part.input) }),
      ...(part.state === "output-available" && {
        output: json(part.output),
        ...(part.preliminary && { preliminary: true })
      }),
      ...(part.state === "output-error" && { errorText: part.errorText }),
      ...(part.approval && {
        approval: {
          id: part.approval.id,
          ...(part.approval.approved !== undefined && {
            approved: part.approval.approved
          }),
          ...(part.approval.reason !== undefined && {
            reason: part.approval.reason
          })
        }
      }),
      ...(owner !== undefined && { owner }),
      ...(part.providerExecuted && { providerExecuted: true }),
      ...(dynamic && { dynamic: true }),
      ...(part.title !== undefined && { title: part.title })
    } satisfies ToolPart,
    part.callProviderMetadata
  );
}

/** Convert a transcript message into an AI SDK UI message. */
export function toUIMessage(message: TranscriptMessage): UIMessage {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts.map(toUIPart),
    ...(message.metadata && { metadata: message.metadata })
  };
}

function toUIPart(part: MessagePart): UIPart {
  switch (part.type) {
    case "data": {
      const { name, ...rest } = part;
      return { ...rest, type: `data-${name}` };
    }
    case "tool": {
      const {
        type: _type,
        toolName,
        dynamic,
        owner: _owner,
        providerMetadata,
        ...rest
      } = part;
      const call = {
        ...rest,
        ...(providerMetadata && { callProviderMetadata: providerMetadata })
      };
      // SAFETY: the state and its fields were produced together by
      // toToolPart, or by an agent following the same ToolState rules.
      return (
        dynamic
          ? { ...call, type: "dynamic-tool", toolName }
          : { ...call, type: `tool-${toolName}` }
      ) as UIPart;
    }
    default:
      // SAFETY: the remaining parts match their AI SDK shapes field for field.
      return part as UIPart;
  }
}

/** Whether the message has a tool call waiting for a result or an approval. */
export function awaitsInput(message: UIMessage): boolean {
  return message.parts.some(
    (part) =>
      "toolCallId" in part &&
      (part.state === "input-available" || part.state === "approval-requested")
  );
}

/** A tool result or approval response, as an inbound event carries it. */
export type ToolCallAnswer =
  | Pick<
      Extract<InboundEvent, { type: "tool-result" }>,
      "type" | "toolCallId" | "result"
    >
  | Pick<
      Extract<InboundEvent, { type: "approval-response" }>,
      "type" | "approvalId" | "approved" | "reason"
    >;

/**
 * Record a tool result or approval response on the tool call it answers.
 * Returns the updated message, or undefined when no call is waiting for it,
 * so the first answer wins.
 */
export function answerToolCall(
  messages: readonly UIMessage[],
  event: ToolCallAnswer
): UIMessage | undefined {
  for (const message of messages) {
    const index = message.parts.findIndex((part) => answers(part, event));
    if (index === -1) continue;
    const parts = [...message.parts];
    const part = parts[index] as UIToolPart;
    // SAFETY: the new state is set with exactly the fields it requires.
    parts[index] = (
      event.type === "approval-response"
        ? {
            ...part,
            // As the AI SDK records them: a rejection ends the call.
            state: event.approved ? "approval-responded" : "output-denied",
            approval: {
              id: event.approvalId,
              approved: event.approved,
              ...(event.reason !== undefined && { reason: event.reason })
            }
          }
        : event.type === "tool-result" && event.result.ok
          ? { ...part, state: "output-available", output: event.result.output }
          : {
              ...part,
              state: "output-error",
              errorText:
                event.type === "tool-result" && !event.result.ok
                  ? (event.result.errorText ?? "")
                  : ""
            }
    ) as UIPart;
    return { ...message, parts };
  }
  return undefined;
}

function answers(part: UIPart, event: ToolCallAnswer): boolean {
  if (!("toolCallId" in part)) return false;
  if (event.type === "tool-result") {
    return (
      part.toolCallId === event.toolCallId &&
      // An approved client tool is answered after its approval.
      (part.state === "input-available" || part.state === "approval-responded")
    );
  }
  return (
    event.type === "approval-response" &&
    part.state === "approval-requested" &&
    part.approval.id === event.approvalId
  );
}
