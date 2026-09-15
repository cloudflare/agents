import type { UIMessageChunk } from "ai";
import type { Connection } from "../../lifecycle";
import {
  CHAT_MESSAGE_TYPES,
  STREAM_RESUME_NONE_REASONS
} from "../../chat/protocol";
import { parseProtocolMessage } from "../../chat/parse-protocol";
import type { StreamStatus, Streams } from "../../streams";
import { WebSockets, type WebSocketsOptions } from "../../websockets";
import {
  channelChunkToUIChunks,
  finishUIConversion,
  newUIConverterState
} from "../ai-sdk-stream";
import type {
  Channel,
  ChannelApprovalRequestOptions,
  ChannelChunk,
  ChannelConversationChunk,
  ChannelConversationMessage,
  ChannelMessage,
  ChannelMessageResolver,
  ChannelRoute,
  ChannelStreamOptions,
  DeliveryResult
} from "../channel";
import type {
  ChannelApprovalResponseInput,
  ChannelCancelRequestInput,
  ChannelConversationResetRequestInput,
  ChannelIngress,
  ChannelIngressEnvelope,
  ChannelToolResultInput
} from "../ingress";
import {
  bindChannelHost,
  bindChannelIngress,
  defaultText,
  describeChannelResponse,
  type BindableChannelHost,
  type BindableChannelIngress,
  type ChannelHostServices,
  type ChannelIngressDispatchOutcome,
  type DescribableChannelResponse
} from "../internal";
import { consumeChunks } from "../stream";
import {
  isChannelMessageSurface,
  type ChannelMessageSurface
} from "../surface";
import {
  normalizeClientTools,
  normalizeWebChatRequest,
  type WebChatRequestBody
} from "./web-protocol";

export type WebChatSurface = ChannelMessageSurface<
  string,
  {
    conversationId: string;
    ownerConnectionId: string;
    requestId: string;
    participantId?: string;
    clientToolNames?: string[];
    continuation?: boolean;
  }
>;

export type WebConnectionIdentity = {
  conversationId: string;
  participantId: string;
};

type WebChatRequestIngressPayload = {
  type: "chat-request";
  requestId: string;
  init: { method?: string; body?: string; [key: string]: unknown };
  body: WebChatRequestBody;
};

type WebApprovalResponseIngressPayload = {
  type: "approval-response";
  toolCallId: string;
  approved: boolean;
  autoContinue?: boolean;
};

type WebCancelIngressPayload = {
  type: "cancel-request";
  requestId: string;
};

type WebConversationResetIngressPayload = {
  type: "conversation-reset-request";
};

type WebToolResultIngressPayload = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown;
  state?: string;
  errorText?: string;
  autoContinue?: boolean;
  clientTools?: unknown;
};

/** Exact browser event retained for application routing. */
export type WebChatIngressPayload =
  | WebChatRequestIngressPayload
  | WebApprovalResponseIngressPayload
  | WebCancelIngressPayload
  | WebConversationResetIngressPayload
  | WebToolResultIngressPayload;

export type WebChannelOptions = {
  /** @deprecated Configure `ChannelHost.resolveMessages` instead. */
  resolveMessages?: ChannelMessageResolver;
  /** Resolve the same stable identities for upgrades and `/get-messages`. */
  resolveIdentity?: (
    request: Request
  ) => WebConnectionIdentity | Promise<WebConnectionIdentity>;
  /** Select an application route from the browser turn and Host context. */
  route?: ChannelRoute<WebChatIngressPayload>;
  /** Additional configuration for the owned WebSockets capability. */
  webSockets?: Omit<WebSocketsOptions, "handlers">;
};

/**
 * A browser chat Channel paired with the WebSockets capability it uses.
 * Install `webSockets` into the Durable Object's Lifecycle.
 */
export interface WebChannel extends Channel<WebChatIngressPayload> {
  readonly webSockets: WebSockets;
}

type WebChatAddress = WebChatSurface["address"];

type PendingToolContinuation = {
  connectionId: string;
  rootRequestId: string;
  requestId: string;
  probeId?: string;
  ready: boolean;
  activeDispatches: number;
  handled: boolean;
  acknowledged: Promise<boolean>;
  settle(acknowledged: boolean): void;
};

type ClientToolCall = {
  requestId: string;
  toolName: string;
};

type PendingResponseReplay = {
  streamId: string;
  status: StreamStatus;
};

type WebResponseMetadata = {
  requestId: string;
  ownerParticipantId: string;
  clientToolNames: ReadonlySet<string>;
  continuation: boolean;
};

const CONVERSATION_TAG_PREFIX = "cf-web-conversation:";
const PARTICIPANT_TAG_PREFIX = "cf-web-participant:";

function conversationTag(conversationId: string): string {
  return `${CONVERSATION_TAG_PREFIX}${conversationId}`;
}

function participantTag(participantId: string): string {
  return `${PARTICIPANT_TAG_PREFIX}${participantId}`;
}

function approvalReference(
  conversationId: string,
  interactionId: string
): string {
  return `web:${conversationId}:approval:${interactionId}`;
}

function hasToolCallId(
  chunk: UIMessageChunk
): chunk is UIMessageChunk & { toolCallId: string } {
  return "toolCallId" in chunk && typeof chunk.toolCallId === "string";
}

function pendingToolContinuation(
  connectionId: string,
  rootRequestId: string
): PendingToolContinuation {
  let settle!: (acknowledged: boolean) => void;
  const acknowledged = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  return {
    connectionId,
    rootRequestId,
    requestId: crypto.randomUUID(),
    ready: false,
    activeDispatches: 0,
    handled: false,
    acknowledged,
    settle
  };
}

function addressOf(surface: ChannelMessageSurface): WebChatAddress | null {
  if (
    !isChannelMessageSurface(surface) ||
    surface.version !== 1 ||
    surface.address === null ||
    typeof surface.address !== "object" ||
    Array.isArray(surface.address)
  ) {
    return null;
  }
  const address = surface.address as Record<string, unknown>;
  return typeof address.conversationId === "string" &&
    typeof address.ownerConnectionId === "string" &&
    typeof address.requestId === "string"
    ? {
        conversationId: address.conversationId,
        ownerConnectionId: address.ownerConnectionId,
        requestId: address.requestId,
        ...(typeof address.participantId === "string" && {
          participantId: address.participantId
        }),
        ...(Array.isArray(address.clientToolNames) &&
          address.clientToolNames.every((name) => typeof name === "string") && {
            clientToolNames: address.clientToolNames
          }),
        ...(address.continuation === true && { continuation: true })
      }
    : null;
}

function streamFailure(
  sent: boolean,
  code: string,
  message: string,
  reference: string
): DeliveryResult {
  return sent
    ? { status: "uncertain", reference, error: { code, message } }
    : { status: "failed", retryable: true, error: { code, message } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The stream ended early";
}

function conversationMessageToUIMessage(
  message: ChannelConversationMessage,
  participantId?: string
) {
  const content = message.content.filter((chunk) =>
    isVisibleToParticipant(chunk, participantId)
  );
  const converter = newUIConverterState();
  const parts: unknown[] = [];
  for (const chunk of content) {
    for (const output of channelChunkToUIChunks(chunk, converter)) {
      parts.push(...uiChunkToMessageParts(output));
    }
  }
  for (const output of finishUIConversion(converter)) {
    parts.push(...uiChunkToMessageParts(output));
  }
  return {
    id: message.id,
    role:
      message.author.type === "participant"
        ? ("user" as const)
        : message.author.type === "agent"
          ? ("assistant" as const)
          : ("system" as const),
    parts
  };
}

function projectConversationMessage(
  message: ChannelConversationMessage,
  participantId?: string
): ReturnType<typeof conversationMessageToUIMessage> | null {
  const projected = conversationMessageToUIMessage(message, participantId);
  return projected.parts.length > 0 ? projected : null;
}

function uiChunkToMessageParts(chunk: UIMessageChunk): unknown[] {
  switch (chunk.type) {
    case "text-delta":
      return [{ type: "text", text: chunk.delta }];
    case "reasoning-delta":
      return [{ type: "reasoning", text: chunk.delta }];
    case "tool-input-available":
      return [
        {
          type: `tool-${chunk.toolName}`,
          toolCallId: chunk.toolCallId,
          state: "input-available",
          input: chunk.input,
          ...(chunk.providerExecuted !== undefined && {
            providerExecuted: chunk.providerExecuted
          })
        }
      ];
    case "tool-output-available":
      return [
        {
          type: "dynamic-tool",
          toolCallId: chunk.toolCallId,
          toolName: "tool",
          state: "output-available",
          output: chunk.output,
          ...(chunk.providerExecuted !== undefined && {
            providerExecuted: chunk.providerExecuted
          })
        }
      ];
    case "source-url":
      return [
        {
          type: "source-url",
          sourceId: chunk.sourceId,
          url: chunk.url,
          ...(chunk.title !== undefined && { title: chunk.title })
        }
      ];
    case "file":
      return [{ type: "file", url: chunk.url, mediaType: chunk.mediaType }];
    default:
      return [];
  }
}

function isVisibleToParticipant(
  chunk: ChannelConversationChunk,
  participantId?: string
): boolean {
  return (
    chunk.audience?.type !== "participant" ||
    chunk.audience.participantId === participantId
  );
}

function responseFrame(
  requestId: string,
  body: UIMessageChunk | string,
  options: { done: boolean; error?: boolean; continuation?: boolean }
): string {
  return JSON.stringify({
    body: typeof body === "string" ? body : JSON.stringify(body),
    done: options.done,
    id: requestId,
    type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
    ...(options.error === true && { error: true }),
    ...(options.continuation === true && { continuation: true })
  });
}

class ConfiguredWebChannel
  implements
    WebChannel,
    BindableChannelHost,
    BindableChannelIngress<WebChatIngressPayload>,
    DescribableChannelResponse
{
  readonly route: ChannelRoute<WebChatIngressPayload> | undefined;
  readonly webSockets: WebSockets;
  readonly ingress: ChannelIngress<WebChatIngressPayload>;
  readonly #resolveIdentity: (
    request: Request
  ) => Promise<WebConnectionIdentity>;
  #channelKey: string | undefined;
  #resolveMessages: ChannelMessageResolver | undefined;
  #responseStreams: Pick<Streams, "list" | "read" | "status"> | undefined;
  readonly #active = new Map<string, AbortController>();
  readonly #pendingResponseReplays = new Map<string, PendingResponseReplay>();
  readonly #replayingConnections = new Set<string>();
  readonly #replayControllers = new Map<
    string,
    { abort: AbortController; requestId: string }
  >();
  readonly #pendingToolContinuations = new Map<
    string,
    PendingToolContinuation
  >();
  readonly #clientToolCalls = new Map<string, ClientToolCall>();
  readonly #clientToolNamesByRequest = new Map<string, ReadonlySet<string>>();
  readonly #cancelledOperations = new Set<string>();
  readonly #dispatchingOperations = new Set<string>();
  readonly #admittedByConversation = new Map<
    string,
    Map<string, ChannelConversationMessage>
  >();
  #dispatch:
    | ((
        envelope: ChannelIngressEnvelope<WebChatIngressPayload>
      ) => Promise<ChannelIngressDispatchOutcome>)
    | undefined;

  constructor(options: WebChannelOptions) {
    this.route = options.route;
    this.#resolveMessages = options.resolveMessages;
    this.#resolveIdentity = async (request) => {
      if (options.resolveIdentity) return options.resolveIdentity(request);
      const url = new URL(request.url);
      const conversationId =
        url.searchParams.get("conversationId") ??
        url.searchParams.get("name") ??
        "default-conversation";
      return {
        conversationId,
        participantId: url.searchParams.get("participantId") ?? conversationId
      };
    };
    this.ingress = {
      receive: async (request) => {
        const response = await this.#initialMessagesResponse(request);
        return response ? { events: [], response } : null;
      }
    };
    const configuredTags = options.webSockets?.getConnectionTags;
    this.webSockets = new WebSockets({
      ...options.webSockets,
      getConnectionTags: async (connection, context) => {
        const identity = await this.#resolveIdentity(context.request);
        const tags = configuredTags
          ? await configuredTags(connection, context)
          : [];
        return [
          conversationTag(identity.conversationId),
          participantTag(identity.participantId),
          ...tags.filter(
            (tag) =>
              tag !== conversationTag(identity.conversationId) &&
              tag !== participantTag(identity.participantId)
          )
        ];
      },
      handlers: {
        onConnect: (connection) => this.#hydrateConnection(connection),
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection) => this.#cancelConnection(connection.id),
        onError: (connection) => this.#cancelConnection(connection.id)
      }
    });
  }

  [bindChannelHost](services: ChannelHostServices): void {
    this.#channelKey = services.channelKey;
    this.#resolveMessages = services.resolveMessages ?? this.#resolveMessages;
    this.#responseStreams = services.responseStreams;
  }

  [describeChannelResponse](
    surface: ChannelMessageSurface,
    _options: ChannelStreamOptions
  ): Record<string, import("../../streams").StreamJson> | undefined {
    const address = addressOf(surface);
    if (!address) return undefined;
    const owner = this.webSockets.getConnection(address.ownerConnectionId);
    const ownerParticipantId =
      address.participantId ??
      (owner ? this.#identityOf(owner).participantId : undefined);
    if (!ownerParticipantId) return undefined;
    return {
      channelType: "web",
      webRequestId: address.requestId,
      webOwnerParticipantId: ownerParticipantId,
      webClientToolNames: [
        ...(address.clientToolNames ??
          this.#clientToolNamesByRequest.get(
            this.#requestKey(address.ownerConnectionId, address.requestId)
          ) ??
          [])
      ],
      webContinuation: address.continuation === true
    };
  }

  [bindChannelIngress](
    dispatch: (
      envelope: ChannelIngressEnvelope<WebChatIngressPayload>
    ) => Promise<ChannelIngressDispatchOutcome>
  ): void {
    if (this.#dispatch) {
      throw new Error(
        "A web Channel can only be configured in one ChannelHost"
      );
    }
    this.#dispatch = dispatch;
  }

  isAvailable(surface: ChannelMessageSurface): boolean {
    const address = addressOf(surface);
    return Boolean(
      address &&
      [
        ...this.webSockets.getConnections(
          conversationTag(address.conversationId)
        )
      ].length > 0
    );
  }

  async requestApproval(
    surface: ChannelMessageSurface,
    { interactionId, request }: ChannelApprovalRequestOptions
  ): Promise<DeliveryResult> {
    const address = addressOf(surface);
    if (!interactionId) {
      return {
        status: "failed",
        retryable: false,
        error: {
          code: "WEB_CHAT_APPROVAL_INVALID",
          message: "Web chat approvals require a non-empty interaction ID"
        }
      };
    }
    if (!address) {
      return {
        status: "failed",
        retryable: false,
        error: {
          code: "WEB_CHAT_SURFACE_INVALID",
          message: `Web chat cannot parse the address for Channel "${surface.channelKey}"`
        }
      };
    }
    const owner = this.webSockets.getConnection(address.ownerConnectionId);
    if (!owner) {
      return {
        status: "failed",
        retryable: true,
        error: {
          code: "WEB_CHAT_CONNECTION_UNAVAILABLE",
          message: "The browser connection is no longer available"
        }
      };
    }

    const encoder = newUIConverterState();
    const summaryId = `approval:${interactionId}:summary`;
    const chunks: ChannelChunk[] = [
      { type: "message-start", messageId: `approval:${interactionId}` },
      { type: "text-start", id: summaryId },
      { type: "text", id: summaryId, text: request.summary },
      { type: "text-end", id: summaryId },
      {
        type: "tool-input-available",
        toolCallId: interactionId,
        toolName: "approval",
        input: request.input,
        ...(request.title !== undefined && { title: request.title })
      },
      {
        type: "tool-approval-request",
        approvalId: interactionId,
        toolCallId: interactionId
      },
      { type: "message-finish", finishReason: "tool-calls" }
    ];
    const reference = approvalReference(address.conversationId, interactionId);
    let sent = false;
    try {
      for (const chunk of chunks) {
        for (const output of channelChunkToUIChunks(chunk, encoder)) {
          owner.send(responseFrame(address.requestId, output, { done: false }));
          sent = true;
        }
      }
      for (const output of finishUIConversion(encoder)) {
        owner.send(responseFrame(address.requestId, output, { done: false }));
        sent = true;
      }
      owner.send(responseFrame(address.requestId, "", { done: true }));
      return { status: "delivered", reference };
    } catch (error) {
      return sent
        ? {
            status: "uncertain",
            reference,
            error: {
              code: "WEB_CHAT_DELIVERY_FAILED",
              message: errorMessage(error)
            }
          }
        : {
            status: "failed",
            retryable: true,
            error: {
              code: "WEB_CHAT_DELIVERY_FAILED",
              message: errorMessage(error)
            }
          };
    }
  }

  deliver(
    surface: ChannelMessageSurface,
    message: ChannelMessage
  ): Promise<DeliveryResult> {
    const text = defaultText(message);
    return this.stream(
      surface,
      new ReadableStream<ChannelChunk>({
        start(controller) {
          controller.enqueue({ type: "text", text });
          controller.close();
        }
      }),
      {}
    );
  }

  async stream(
    surface: ChannelMessageSurface,
    chunks: ReadableStream<ChannelChunk>,
    options: ChannelStreamOptions
  ): Promise<DeliveryResult> {
    const address = addressOf(surface);
    if (!address) {
      await chunks.cancel().catch(() => {});
      return {
        status: "failed",
        retryable: false,
        error: {
          code: "WEB_CHAT_SURFACE_INVALID",
          message: `Web chat cannot parse the address for Channel "${surface.channelKey}"`
        }
      };
    }

    const owner = this.webSockets.getConnection(address.ownerConnectionId);
    const conversationConnections = () => [
      ...this.webSockets.getConnections(conversationTag(address.conversationId))
    ];
    const durablyRecorded = Boolean(this.#responseStreams && options.response);
    if (
      (!owner || conversationConnections().length === 0) &&
      !durablyRecorded
    ) {
      await chunks.cancel().catch(() => {});
      return {
        status: "failed",
        retryable: true,
        error: {
          code: "WEB_CHAT_CONNECTION_UNAVAILABLE",
          message: "The browser connection is no longer available"
        }
      };
    }

    const key = this.#requestKey(address.ownerConnectionId, address.requestId);
    if (this.#cancelledOperations.has(key)) {
      const reason = new DOMException(
        "The browser cancelled the request",
        "AbortError"
      );
      await chunks.cancel(reason).catch(() => {});
      return {
        status: "failed",
        retryable: false,
        error: {
          code: "WEB_CHAT_REQUEST_CANCELLED",
          message: reason.message
        }
      };
    }
    let continuation: PendingToolContinuation | undefined;
    if (address.continuation) {
      continuation = this.#pendingToolContinuations.get(key);
      if (!continuation || continuation.requestId !== address.requestId) {
        await chunks.cancel().catch(() => {});
        return {
          status: "failed",
          retryable: false,
          error: {
            code: "WEB_CHAT_CONTINUATION_UNAVAILABLE",
            message: "The browser is not waiting for this tool continuation"
          }
        };
      }
      if (!owner) {
        await chunks.cancel().catch(() => {});
        return {
          status: "failed",
          retryable: true,
          error: {
            code: "WEB_CHAT_CONTINUATION_CONNECTION_UNAVAILABLE",
            message: "The browser continuation owner disconnected"
          }
        };
      }
      continuation.ready = true;
      if (continuation.probeId !== undefined) {
        this.#sendToolContinuationOffer(owner, continuation);
      }
      if (!(await continuation.acknowledged)) {
        await chunks.cancel().catch(() => {});
        return {
          status: "failed",
          retryable: true,
          error: {
            code: "WEB_CHAT_CONTINUATION_CANCELLED",
            message: "The browser stopped waiting for the tool continuation"
          }
        };
      }
    }

    this.#active.get(key)?.abort();
    const abort = new AbortController();
    this.#active.set(key, abort);
    const encoder = newUIConverterState();
    const reference = `web:${address.conversationId}:request:${address.requestId}`;
    const configuredClientTools = this.#clientToolNamesByRequest.get(key);
    const clientToolCallIds = new Set<string>();
    let assistantMessageId: string | undefined;
    let sent = false;

    try {
      const result: DeliveryResult = await consumeChunks(
        chunks,
        {
          onChunk: (chunk) => {
            if (chunk.type === "message-start" && chunk.messageId) {
              assistantMessageId = chunk.messageId;
            }
            if (
              chunk.type === "tool-input-start" ||
              chunk.type === "tool-input-available"
            ) {
              const isClientTool = configuredClientTools
                ? configuredClientTools.has(chunk.toolName)
                : chunk.providerExecuted !== true;
              if (isClientTool) clientToolCallIds.add(chunk.toolCallId);
            }
            if (
              chunk.type === "tool-input-available" &&
              clientToolCallIds.has(chunk.toolCallId)
            ) {
              const toolCallKey = this.#toolCallKey(
                address.ownerConnectionId,
                chunk.toolCallId
              );
              if (this.#clientToolCalls.has(toolCallKey)) {
                throw new Error(
                  `Web chat tool-call ID "${chunk.toolCallId}" was already used on this connection`
                );
              }
              this.#clientToolCalls.set(toolCallKey, {
                requestId: address.requestId,
                toolName: chunk.toolName
              });
            }
            for (const output of channelChunkToUIChunks(chunk, encoder)) {
              const recipients =
                hasToolCallId(output) &&
                clientToolCallIds.has(output.toolCallId)
                  ? (() => {
                      const currentOwner = this.webSockets.getConnection(
                        address.ownerConnectionId
                      );
                      return currentOwner ? [currentOwner] : [];
                    })()
                  : conversationConnections();
              const frame = responseFrame(address.requestId, output, {
                done: false,
                continuation: address.continuation
              });
              for (const connection of recipients) {
                if (!this.#replayingConnections.has(connection.id)) {
                  connection.send(frame);
                  sent = true;
                }
              }
            }
          },
          onFinish: (outcome) => {
            if (this.#cancelledOperations.has(key)) {
              return streamFailure(
                sent,
                "WEB_CHAT_REQUEST_CANCELLED",
                "The browser cancelled the request",
                reference
              );
            }
            try {
              for (const output of finishUIConversion(encoder)) {
                const frame = responseFrame(address.requestId, output, {
                  done: false,
                  continuation: address.continuation
                });
                for (const connection of conversationConnections()) {
                  if (!this.#replayingConnections.has(connection.id)) {
                    connection.send(frame);
                    sent = true;
                  }
                }
              }
              if (outcome.interrupted) {
                const message = errorMessage(outcome.error);
                const frame = responseFrame(address.requestId, message, {
                  done: true,
                  error: true,
                  continuation: address.continuation
                });
                for (const connection of conversationConnections()) {
                  if (!this.#replayingConnections.has(connection.id)) {
                    connection.send(frame);
                  }
                }
                return streamFailure(
                  sent,
                  "WEB_CHAT_STREAM_INTERRUPTED",
                  message,
                  reference
                );
              }
              const frame = responseFrame(address.requestId, "", {
                done: true,
                continuation: address.continuation
              });
              for (const connection of conversationConnections()) {
                if (!this.#replayingConnections.has(connection.id)) {
                  connection.send(frame);
                }
              }
              return { status: "delivered", reference };
            } catch (error) {
              return streamFailure(
                sent,
                "WEB_CHAT_DELIVERY_FAILED",
                errorMessage(error),
                reference
              );
            }
          }
        },
        { signal: abort.signal }
      );
      if (
        result.status === "delivered" &&
        !this.#cancelledOperations.has(key) &&
        assistantMessageId !== undefined &&
        this.#resolveMessages
      ) {
        const snapshot = await this.#resolveMessages({
          conversationId: address.conversationId
        });
        if (
          snapshot.messages.some((message) => message.id === assistantMessageId)
        ) {
          const messages = this.#mergeAdmitted(
            address.conversationId,
            snapshot.messages
          );
          for (const connection of conversationConnections()) {
            if (this.#replayingConnections.has(connection.id)) continue;
            const participantId = this.#identityOf(connection).participantId;
            connection.send(
              JSON.stringify({
                type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
                messages: messages.flatMap((message) => {
                  const projected = projectConversationMessage(
                    message,
                    participantId
                  );
                  return projected ? [projected] : [];
                })
              })
            );
          }
        }
      }
      return result;
    } finally {
      if (this.#active.get(key) === abort) this.#active.delete(key);
      if (
        continuation &&
        this.#pendingToolContinuations.get(key) === continuation
      ) {
        this.#pendingToolContinuations.delete(key);
      }
    }
  }

  async #initialMessagesResponse(
    request: Request
  ): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (request.method !== "GET" || !url.pathname.endsWith("/get-messages")) {
      return undefined;
    }
    if (!this.#resolveMessages) return Response.json([]);

    const identity = await this.#resolveIdentity(request);
    return Response.json(await this.#projectedMessages(identity));
  }

  async #projectedMessages(
    identity: WebConnectionIdentity
  ): Promise<NonNullable<ReturnType<typeof projectConversationMessage>>[]> {
    if (!this.#resolveMessages) return [];
    const snapshot = await this.#resolveMessages({
      conversationId: identity.conversationId
    });
    const messages = this.#mergeAdmitted(
      identity.conversationId,
      snapshot.messages
    );
    return messages.flatMap((message) => {
      const projected = projectConversationMessage(
        message,
        identity.participantId
      );
      return projected ? [projected] : [];
    });
  }

  async #hydrateConnection(connection: Connection): Promise<void> {
    if (!this.#resolveMessages) return;
    const identity = this.#identityOf(connection);
    connection.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
        messages: await this.#projectedMessages(identity)
      })
    );
  }

  async #onMessage(
    connection: Connection,
    message: string | ArrayBuffer | ArrayBufferView
  ): Promise<void> {
    if (typeof message !== "string") return;
    const event = parseProtocolMessage(message);
    if (!event) return;

    switch (event.type) {
      case "chat-request":
        await this.#onChatRequest(connection, event.id, event.init);
        return;
      case "cancel": {
        const operationKey = this.#requestKey(connection.id, event.id);
        const active = this.#active.get(operationKey);
        const pending = this.#pendingToolContinuations.get(operationKey);
        if (
          active ||
          pending ||
          this.#dispatchingOperations.has(operationKey)
        ) {
          this.#cancelledOperations.add(operationKey);
        }
        active?.abort(
          new DOMException("The browser cancelled the request", "AbortError")
        );
        const replay = this.#replayControllers.get(connection.id);
        if (replay?.requestId === event.id) {
          replay.abort.abort(
            new DOMException("The browser cancelled the replay", "AbortError")
          );
        }
        pending?.settle(false);
        this.#pendingToolContinuations.delete(operationKey);
        if (this.#dispatch) {
          const identity = this.#identityOf(connection);
          const raw = {
            type: "cancel-request",
            requestId: event.id
          } satisfies WebCancelIngressPayload;
          const request = {
            type: "cancel-request",
            eventId: `web:${connection.id}:request:${event.id}:cancel`,
            operationId: event.id,
            thread: { id: identity.conversationId, isDirectMessage: false },
            actor: { id: identity.participantId }
          } satisfies ChannelCancelRequestInput;
          await this.#dispatch({ raw, event: request });
        }
        return;
      }
      case "clear": {
        const identity = this.#identityOf(connection);
        if (this.#dispatch) {
          const raw = {
            type: "conversation-reset-request"
          } satisfies WebConversationResetIngressPayload;
          const request = {
            type: "conversation-reset-request",
            eventId: `web:${connection.id}:conversation-reset`,
            thread: { id: identity.conversationId, isDirectMessage: false },
            actor: { id: identity.participantId }
          } satisfies ChannelConversationResetRequestInput;
          const outcome = await this.#dispatch({ raw, event: request });
          if (outcome === "ignored") return;
        }
        this.#clearConversationState(identity.conversationId);
        const frame = JSON.stringify({ type: CHAT_MESSAGE_TYPES.CHAT_CLEAR });
        for (const member of this.webSockets.getConnections(
          conversationTag(identity.conversationId)
        )) {
          member.send(frame);
        }
        return;
      }
      case "stream-resume-request":
        if (!(await this.#offerResponseReplay(connection, event.probeId))) {
          this.#offerToolContinuation(connection, event.probeId);
        }
        return;
      case "stream-resume-ack":
        if (!(await this.#resumeResponseReplay(connection, event.id))) {
          this.#resumeToolContinuation(connection, event.id);
        }
        return;
      case "tool-result":
        await this.#onToolResult(connection, event);
        return;
      case "tool-approval":
        await this.#onApprovalResponse(connection, event);
        return;
      case "messages":
        return;
    }
  }

  async #onChatRequest(
    connection: Connection,
    requestId: string,
    init: { method?: string; body?: string; [key: string]: unknown }
  ): Promise<void> {
    const requestKey = this.#requestKey(connection.id, requestId);
    try {
      if (
        typeof requestId !== "string" ||
        !requestId ||
        (init.method ?? "POST").toUpperCase() !== "POST"
      ) {
        throw new Error("Web chat requires a POST request with an id");
      }
      const normalized = normalizeWebChatRequest(JSON.parse(init.body ?? ""));
      if (!normalized) {
        throw new Error("Web chat requires a body with a user message");
      }
      if (!this.#dispatch) {
        throw new Error("The web Channel is not configured in a ChannelHost");
      }

      const identity = this.#identityOf(connection);
      this.#clientToolNamesByRequest.set(
        requestKey,
        new Set(normalized.message.clientTools?.map((tool) => tool.name) ?? [])
      );
      const admittedMessage: ChannelConversationMessage = {
        id: normalized.message.id,
        author: {
          type: "participant",
          participantId: identity.participantId
        },
        content: [{ type: "text", text: normalized.message.text }]
      };
      this.#admittedMessages(identity.conversationId).set(
        admittedMessage.id,
        admittedMessage
      );
      this.#dispatchingOperations.add(requestKey);
      const resolvedMessages = this.#resolveMessages
        ? (
            await this.#resolveMessages({
              conversationId: identity.conversationId
            })
          ).messages
        : [];
      const canonicalMessages = this.#mergeAdmitted(
        identity.conversationId,
        resolvedMessages
      );
      const messages = canonicalMessages.flatMap((message) => {
        const projected = projectConversationMessage(
          message,
          identity.participantId
        );
        return projected ? [projected] : [];
      });
      if (!messages.some((message) => message.id === normalized.message.id)) {
        messages.push({
          id: normalized.message.id,
          role: "user",
          parts: [{ type: "text", text: normalized.message.text }]
        });
      }
      const messageFrame = JSON.stringify({
        type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
        messages
      });
      for (const member of this.webSockets.getConnections(
        conversationTag(identity.conversationId)
      )) {
        if (member.id !== connection.id) member.send(messageFrame);
      }

      const raw = {
        type: "chat-request",
        requestId,
        init,
        body: normalized.body
      } satisfies WebChatIngressPayload;
      try {
        await this.#dispatch({
          raw,
          event: {
            type: "message",
            eventId: `web:${connection.id}:request:${requestId}`,
            operationId: requestId,
            thread: { id: identity.conversationId, isDirectMessage: false },
            replySurface: {
              version: 1,
              address: {
                conversationId: identity.conversationId,
                ownerConnectionId: connection.id,
                requestId,
                participantId: identity.participantId,
                ...((normalized.message.clientTools?.length ?? 0) > 0 && {
                  clientToolNames:
                    normalized.message.clientTools?.map((tool) => tool.name) ??
                    []
                })
              },
              label: "Web chat"
            },
            actor: { id: identity.participantId },
            message: normalized.message
          }
        });
      } finally {
        this.#dispatchingOperations.delete(requestKey);
        this.#cancelledOperations.delete(requestKey);
      }
    } catch (error) {
      this.#dispatchingOperations.delete(requestKey);
      this.#cancelledOperations.delete(requestKey);
      connection.send(
        responseFrame(requestId, errorMessage(error), {
          done: true,
          error: true
        })
      );
    }
  }

  async #onToolResult(
    connection: Connection,
    event: Extract<
      ReturnType<typeof parseProtocolMessage>,
      { type: "tool-result" }
    >
  ): Promise<void> {
    if (!this.#dispatch || !event) return;
    if (!event.toolCallId || !event.toolName) return;

    if (
      event.state !== undefined &&
      event.state !== "output-available" &&
      event.state !== "output-error"
    ) {
      return;
    }
    if (
      event.autoContinue !== undefined &&
      typeof event.autoContinue !== "boolean"
    ) {
      return;
    }
    const toolCall = this.#clientToolCalls.get(
      this.#toolCallKey(connection.id, event.toolCallId)
    );
    if (!toolCall || toolCall.toolName !== event.toolName) return;

    const clientTools = normalizeClientTools(event.clientTools);
    const identity = this.#identityOf(connection);
    const raw = {
      type: "tool-result",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      output: event.output,
      state: event.state,
      errorText: event.errorText,
      autoContinue: event.autoContinue,
      clientTools: event.clientTools
    } satisfies WebToolResultIngressPayload;
    const toolResult = {
      type: "tool-result",
      eventId: `web:${connection.id}:request:${toolCall.requestId}:tool-result:${event.toolCallId}`,
      operationId: toolCall.requestId,
      thread: { id: identity.conversationId, isDirectMessage: false },
      actor: { id: identity.participantId },
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result:
        event.state === "output-error"
          ? {
              success: false as const,
              error: event.errorText ?? "Client tool execution failed"
            }
          : { success: true as const, output: event.output },
      ...(event.autoContinue !== undefined && {
        autoContinue: event.autoContinue
      }),
      ...(clientTools.length > 0 && { clientTools })
    } satisfies ChannelToolResultInput;
    if (event.autoContinue !== true) {
      await this.#dispatch({ raw, event: toolResult });
      return;
    }

    let pending = this.#findPendingToolContinuation(
      connection.id,
      toolCall.requestId
    );
    if (!pending) {
      pending = pendingToolContinuation(connection.id, toolCall.requestId);
      this.#pendingToolContinuations.set(
        this.#requestKey(connection.id, pending.requestId),
        pending
      );
    }
    const pendingKey = this.#requestKey(connection.id, pending.requestId);

    pending.activeDispatches += 1;
    try {
      const outcome = await this.#dispatch({
        raw,
        event: {
          ...toolResult,
          operationId: pending.requestId,
          replySurface: {
            version: 1,
            address: {
              conversationId: identity.conversationId,
              ownerConnectionId: connection.id,
              requestId: pending.requestId,
              participantId: identity.participantId,
              ...(clientTools.length > 0 && {
                clientToolNames: clientTools.map((tool) => tool.name)
              }),
              continuation: true
            },
            label: "Web chat continuation"
          }
        }
      });
      if (outcome === "handled") pending.handled = true;
    } finally {
      pending.activeDispatches -= 1;
      if (
        !pending.handled &&
        pending.activeDispatches === 0 &&
        this.#pendingToolContinuations.get(pendingKey) === pending
      ) {
        pending.settle(false);
        this.#pendingToolContinuations.delete(pendingKey);
      }
    }
  }

  async #onApprovalResponse(
    connection: Connection,
    event: Extract<
      ReturnType<typeof parseProtocolMessage>,
      { type: "tool-approval" }
    >
  ): Promise<void> {
    if (!this.#dispatch || !event.toolCallId) return;
    if (typeof event.approved !== "boolean") return;
    if (
      event.autoContinue !== undefined &&
      typeof event.autoContinue !== "boolean"
    ) {
      return;
    }

    const identity = this.#identityOf(connection);
    const raw = {
      type: "approval-response",
      toolCallId: event.toolCallId,
      approved: event.approved,
      ...(event.autoContinue !== undefined && {
        autoContinue: event.autoContinue
      })
    } satisfies WebApprovalResponseIngressPayload;
    const approval = {
      type: "approval-response",
      eventId: `web:${connection.id}:approval:${event.toolCallId}`,
      thread: { id: identity.conversationId, isDirectMessage: false },
      actor: { id: identity.participantId },
      interactionId: event.toolCallId,
      decision: event.approved ? "approve" : "reject",
      ...(event.autoContinue !== undefined && {
        autoContinue: event.autoContinue
      }),
      reference: approvalReference(identity.conversationId, event.toolCallId)
    } satisfies ChannelApprovalResponseInput;
    if (event.autoContinue !== true) {
      await this.#dispatch({ raw, event: approval });
      return;
    }

    const pending = pendingToolContinuation(connection.id, event.toolCallId);
    const pendingKey = this.#requestKey(connection.id, pending.requestId);
    this.#pendingToolContinuations.set(pendingKey, pending);
    try {
      const outcome = await this.#dispatch({
        raw,
        event: {
          ...approval,
          operationId: pending.requestId,
          replySurface: {
            version: 1,
            address: {
              conversationId: identity.conversationId,
              ownerConnectionId: connection.id,
              requestId: pending.requestId,
              participantId: identity.participantId,
              continuation: true
            },
            label: "Web chat approval continuation"
          }
        }
      });
      if (outcome === "ignored") {
        pending.settle(false);
        this.#pendingToolContinuations.delete(pendingKey);
      }
    } catch (error) {
      pending.settle(false);
      if (this.#pendingToolContinuations.get(pendingKey) === pending) {
        this.#pendingToolContinuations.delete(pendingKey);
      }
      throw error;
    }
  }

  async #offerResponseReplay(
    connection: Connection,
    probeId?: string
  ): Promise<boolean> {
    const streams = this.#responseStreams;
    if (!streams) return false;
    const active = this.#replayControllers.get(connection.id);
    if (active) {
      connection.send(
        JSON.stringify({
          type: CHAT_MESSAGE_TYPES.STREAM_RESUMING,
          id: active.requestId,
          ...(probeId !== undefined && { probeId })
        })
      );
      return true;
    }
    const identity = this.#identityOf(connection);
    const statuses = await streams.list({
      tag: identity.conversationId,
      limit: 20
    });
    const candidates = statuses.filter(
      (candidate) => this.#webResponseMetadata(candidate) !== null
    );
    let status = candidates.find(
      (candidate) => candidate.state === "streaming"
    );
    if (!status) {
      const latest = candidates[0];
      if (latest && this.#resolveMessages) {
        const snapshot = await this.#resolveMessages({
          conversationId: identity.conversationId
        });
        const messageId = latest.metadata?.messageId;
        const isCanonical =
          typeof messageId === "string" &&
          snapshot.messages.some((message) => message.id === messageId);
        status =
          !isCanonical || (await this.#responseContainsClientTool(latest))
            ? latest
            : undefined;
      } else {
        status = latest;
      }
    }
    if (!status) return false;

    const metadata = this.#webResponseMetadata(status)!;

    this.#pendingResponseReplays.set(connection.id, {
      streamId: status.streamId,
      status
    });
    this.#replayingConnections.add(connection.id);
    connection.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUMING,
        id: metadata.requestId,
        ...(probeId !== undefined && { probeId })
      })
    );
    return true;
  }

  async #resumeResponseReplay(
    connection: Connection,
    streamId: string
  ): Promise<boolean> {
    const active = this.#replayControllers.get(connection.id);
    if (active?.requestId === streamId) return true;
    const pending = this.#pendingResponseReplays.get(connection.id);
    const metadata = pending ? this.#webResponseMetadata(pending.status) : null;
    if (!pending || metadata?.requestId !== streamId) return false;
    this.#pendingResponseReplays.delete(connection.id);
    if (metadata.continuation) {
      this.#pendingToolContinuations
        .get(this.#requestKey(connection.id, metadata.requestId))
        ?.settle(true);
    }
    await this.#replayResponse(connection, pending);
    return true;
  }

  async #replayResponse(
    connection: Connection,
    replay: PendingResponseReplay
  ): Promise<void> {
    const streams = this.#responseStreams;
    if (!streams) return;
    const metadata = this.#webResponseMetadata(replay.status);
    if (!metadata) return;
    const participantId = this.#identityOf(connection).participantId;
    const ownsParticipantLocalContent =
      participantId === metadata.ownerParticipantId;
    if (ownsParticipantLocalContent) {
      this.#clientToolNamesByRequest.set(
        this.#requestKey(connection.id, metadata.requestId),
        metadata.clientToolNames
      );
    }
    const clientToolCallIds = new Set<string>();
    const encoder = newUIConverterState();
    const abort = new AbortController();
    const active = { abort, requestId: metadata.requestId };
    this.#replayControllers.set(connection.id, active);

    try {
      for await (const entry of streams.read(replay.streamId, {
        signal: abort.signal
      })) {
        const chunk = entry.chunk as ChannelChunk;
        if (
          (chunk.type === "tool-input-start" ||
            chunk.type === "tool-input-available") &&
          metadata.clientToolNames.has(chunk.toolName)
        ) {
          clientToolCallIds.add(chunk.toolCallId);
          if (
            ownsParticipantLocalContent &&
            chunk.type === "tool-input-available"
          ) {
            this.#clientToolCalls.set(
              this.#toolCallKey(connection.id, chunk.toolCallId),
              {
                requestId: metadata.requestId,
                toolName: chunk.toolName
              }
            );
          }
        }
        for (const output of channelChunkToUIChunks(chunk, encoder)) {
          const participantLocal =
            hasToolCallId(output) && clientToolCallIds.has(output.toolCallId);
          if (participantLocal && !ownsParticipantLocalContent) {
            continue;
          }
          connection.send(
            responseFrame(metadata.requestId, output, {
              done: false,
              continuation: metadata.continuation
            })
          );
        }
      }
      for (const output of finishUIConversion(encoder)) {
        connection.send(
          responseFrame(metadata.requestId, output, {
            done: false,
            continuation: metadata.continuation
          })
        );
      }
      const settled = await streams.status(replay.streamId);
      if (settled?.state === "errored") {
        connection.send(
          responseFrame(
            metadata.requestId,
            settled.error ?? "The stream ended early",
            {
              done: true,
              error: true,
              continuation: metadata.continuation
            }
          )
        );
      } else {
        connection.send(
          responseFrame(metadata.requestId, "", {
            done: true,
            continuation: metadata.continuation
          })
        );
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        try {
          connection.send(
            responseFrame(metadata.requestId, errorMessage(error), {
              done: true,
              error: true,
              continuation: metadata.continuation
            })
          );
        } catch {
          // The connection failed while replay was already terminating.
        }
      }
    } finally {
      if (this.#replayControllers.get(connection.id) === active) {
        this.#replayControllers.delete(connection.id);
      }
      this.#replayingConnections.delete(connection.id);
    }
  }

  async #responseContainsClientTool(status: StreamStatus): Promise<boolean> {
    const streams = this.#responseStreams;
    const metadata = this.#webResponseMetadata(status);
    if (!streams || !metadata || metadata.clientToolNames.size === 0) {
      return false;
    }
    const pending = new Set<string>();
    for await (const entry of streams.read(status.streamId)) {
      const chunk = entry.chunk as ChannelChunk;
      if (
        chunk.type === "tool-input-available" &&
        metadata.clientToolNames.has(chunk.toolName)
      ) {
        pending.add(chunk.toolCallId);
      } else if (
        chunk.type === "tool-output-available" ||
        chunk.type === "tool-output-error" ||
        chunk.type === "tool-output-denied"
      ) {
        pending.delete(chunk.toolCallId);
      }
    }
    return pending.size > 0;
  }

  #webResponseMetadata(status: StreamStatus): WebResponseMetadata | null {
    const metadata = status.metadata;
    if (
      metadata?.owner !== "channels" ||
      metadata.channelType !== "web" ||
      metadata.channelKey !== this.#channelKey ||
      metadata.conversationId !== status.tag ||
      typeof metadata.webRequestId !== "string" ||
      typeof metadata.webOwnerParticipantId !== "string" ||
      !Array.isArray(metadata.webClientToolNames) ||
      !metadata.webClientToolNames.every((name) => typeof name === "string")
    ) {
      return null;
    }
    return {
      requestId: metadata.webRequestId,
      ownerParticipantId: metadata.webOwnerParticipantId,
      clientToolNames: new Set(metadata.webClientToolNames),
      continuation: metadata.webContinuation === true
    };
  }

  #offerToolContinuation(connection: Connection, probeId?: string): void {
    const candidates = [...this.#pendingToolContinuations.values()].filter(
      (pending) => pending.connectionId === connection.id
    );
    const pending =
      candidates.find((candidate) => candidate.ready) ?? candidates[0];
    if (!pending) {
      connection.send(
        JSON.stringify({
          type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE,
          reason: STREAM_RESUME_NONE_REASONS.IDLE,
          ...(probeId !== undefined && { probeId })
        })
      );
      return;
    }

    pending.probeId = probeId;
    if (pending.ready) {
      this.#sendToolContinuationOffer(connection, pending);
      return;
    }
    connection.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_PENDING,
        id: pending.requestId,
        ...(probeId !== undefined && { probeId })
      })
    );
  }

  #sendToolContinuationOffer(
    connection: Connection,
    pending: PendingToolContinuation
  ): void {
    connection.send(
      JSON.stringify({
        type: CHAT_MESSAGE_TYPES.STREAM_RESUMING,
        id: pending.requestId,
        ...(pending.probeId !== undefined && { probeId: pending.probeId })
      })
    );
  }

  #resumeToolContinuation(connection: Connection, requestId: string): void {
    this.#pendingToolContinuations
      .get(this.#requestKey(connection.id, requestId))
      ?.settle(true);
  }

  #findPendingToolContinuation(
    connectionId: string,
    rootRequestId: string
  ): PendingToolContinuation | undefined {
    return [...this.#pendingToolContinuations.values()].find(
      (pending) =>
        pending.connectionId === connectionId &&
        pending.rootRequestId === rootRequestId
    );
  }

  #admittedMessages(
    conversationId: string
  ): Map<string, ChannelConversationMessage> {
    let messages = this.#admittedByConversation.get(conversationId);
    if (!messages) {
      messages = new Map();
      this.#admittedByConversation.set(conversationId, messages);
    }
    return messages;
  }

  #mergeAdmitted(
    conversationId: string,
    resolved: readonly ChannelConversationMessage[]
  ): ChannelConversationMessage[] {
    const admitted = this.#admittedByConversation.get(conversationId);
    if (!admitted) return [...resolved];
    const resolvedIds = new Set(resolved.map((message) => message.id));
    for (const id of resolvedIds) admitted.delete(id);
    if (admitted.size === 0)
      this.#admittedByConversation.delete(conversationId);
    return [...resolved, ...admitted.values()];
  }

  #identityOf(connection: Connection): WebConnectionIdentity {
    const conversation = connection.tags.find((tag) =>
      tag.startsWith(CONVERSATION_TAG_PREFIX)
    );
    const participant = connection.tags.find((tag) =>
      tag.startsWith(PARTICIPANT_TAG_PREFIX)
    );
    if (!conversation || !participant) {
      throw new Error("Web chat connection identity is unavailable");
    }
    return {
      conversationId: conversation.slice(CONVERSATION_TAG_PREFIX.length),
      participantId: participant.slice(PARTICIPANT_TAG_PREFIX.length)
    };
  }

  #clearConversationState(conversationId: string): void {
    this.#admittedByConversation.delete(conversationId);
    for (const connection of this.webSockets.getConnections(
      conversationTag(conversationId)
    )) {
      const prefix = `${connection.id}\u0000`;
      for (const key of this.#dispatchingOperations) {
        if (key.startsWith(prefix)) this.#cancelledOperations.add(key);
      }
      for (const [key, controller] of this.#active) {
        if (key.startsWith(prefix)) {
          this.#cancelledOperations.add(key);
          controller.abort(
            new DOMException("The conversation was reset", "AbortError")
          );
          this.#active.delete(key);
        }
      }
      this.#pendingResponseReplays.delete(connection.id);
      this.#replayingConnections.delete(connection.id);
      this.#replayControllers
        .get(connection.id)
        ?.abort.abort(
          new DOMException("The conversation was reset", "AbortError")
        );
      this.#replayControllers.delete(connection.id);
      for (const [key, pending] of this.#pendingToolContinuations) {
        if (key.startsWith(prefix)) {
          pending.settle(false);
          this.#pendingToolContinuations.delete(key);
        }
      }
      for (const key of this.#clientToolCalls.keys()) {
        if (key.startsWith(prefix)) this.#clientToolCalls.delete(key);
      }
      for (const key of this.#clientToolNamesByRequest.keys()) {
        if (key.startsWith(prefix)) this.#clientToolNamesByRequest.delete(key);
      }
    }
  }

  #cancelConnection(connectionId: string): void {
    const prefix = `${connectionId}\u0000`;
    this.#pendingResponseReplays.delete(connectionId);
    this.#replayingConnections.delete(connectionId);
    this.#replayControllers
      .get(connectionId)
      ?.abort.abort(new DOMException("The browser disconnected", "AbortError"));
    this.#replayControllers.delete(connectionId);
    for (const [key, pending] of this.#pendingToolContinuations) {
      if (key.startsWith(prefix)) {
        pending.settle(false);
        this.#pendingToolContinuations.delete(key);
      }
    }
    for (const key of this.#cancelledOperations) {
      if (key.startsWith(prefix) && !this.#dispatchingOperations.has(key)) {
        this.#cancelledOperations.delete(key);
      }
    }
    if (!this.#responseStreams) {
      for (const [key, controller] of this.#active) {
        if (key.startsWith(prefix)) controller.abort();
      }
    }
    for (const key of this.#clientToolCalls.keys()) {
      if (key.startsWith(prefix)) this.#clientToolCalls.delete(key);
    }
    for (const key of this.#clientToolNamesByRequest.keys()) {
      if (key.startsWith(prefix)) this.#clientToolNamesByRequest.delete(key);
    }
  }

  #requestKey(connectionId: string, requestId: string): string {
    return `${connectionId}\u0000${requestId}`;
  }

  #toolCallKey(connectionId: string, toolCallId: string): string {
    return `${connectionId}\u0000${toolCallId}`;
  }
}

/**
 * Create a Channel that speaks the AIChatAgent browser protocol over an owned
 * WebSockets capability. The Host still owns all application message handling.
 */
export function web(options: WebChannelOptions = {}): WebChannel {
  return new ConfiguredWebChannel(options);
}
