import type {
  Channel,
  ChannelApprovalRequestOptions,
  ChannelMessageResolver,
  ChannelChunk,
  ChannelChunkSource,
  ChannelDeliveryOptions,
  ChannelMessage,
  ChannelRoute,
  ChannelResponseContext,
  ChannelRouteContext,
  ChannelStreamOptions,
  DeliveryResult,
  OutboundResolver
} from "../channel";
import { fallbackChannel } from "../fallback";
import { fanoutChannel } from "../fanout";
import type {
  ChannelIdentity,
  ChannelIdentityInput,
  UserIdentity
} from "../identity";
import {
  bindChannelHost,
  bindChannelIngress,
  describeChannelResponse,
  type BindableChannelHost,
  type BindableChannelIngress,
  type ChannelIngressDispatchOutcome,
  type DescribableChannelResponse,
  unsupported
} from "../internal";
import { collectText } from "../stream";
import type {
  ChannelApprovalResponse,
  ChannelCancelRequest,
  ChannelConversationResetRequest,
  ChannelEmailInput,
  ChannelInboundMessage,
  ChannelIngressEnvelope,
  ChannelIngressEvent,
  ChannelIngressEventInput,
  ChannelToolResult
} from "../ingress";
import {
  isChannelMessageSurface,
  type ChannelMessageSurface,
  type ChannelMessageSurfaceInput
} from "../surface";
import type { Streams, StreamWriter } from "../../streams";

export type ChannelMessageEvent = {
  channelKey: string;
  route: string;
  /** Stable identity derived only from the configured Channel and eventId. */
  dispatchId: string;
  message: ChannelInboundMessage;
};

export type ChannelToolResultEvent = {
  channelKey: string;
  route: string;
  /** Stable identity derived only from the configured Channel and eventId. */
  dispatchId: string;
  result: ChannelToolResult;
};

export type ChannelApprovalResponseEvent = {
  channelKey: string;
  route: string;
  /** Stable identity derived only from the configured Channel and eventId. */
  dispatchId: string;
  response: ChannelApprovalResponse;
};

export type ChannelCancelEvent = {
  channelKey: string;
  route: string;
  /** Stable identity derived only from the configured Channel and eventId. */
  dispatchId: string;
  request: ChannelCancelRequest;
};

export type ChannelConversationResetEvent = {
  channelKey: string;
  route: string;
  /** Stable identity derived only from the configured Channel and eventId. */
  dispatchId: string;
  request: ChannelConversationResetRequest;
};

export type ChannelRouteEvent = {
  channelKey: string;
  event: ChannelIngressEvent;
  route: string | null;
  /** Stable identity derived only from the configured Channel and eventId. */
  dispatchId: string;
};

export type ChannelHostOptions = {
  channels: Record<string, Channel>;
  /** Durable response storage used by `stream()`. */
  streams?: Streams;
  /** Resolve canonical conversation history for Channels that synchronize it. */
  resolveMessages?: ChannelMessageResolver;
  /** Used when a Channel does not provide a route. Default: event thread id. */
  defaultRoute?: ChannelRoute;
  /** Resolve an existing, explicitly linked application user. */
  findUser?(identity: ChannelIdentity): Promise<UserIdentity | null>;
  /** Observes every valid route outcome before application dispatch. */
  onRoute?(event: ChannelRouteEvent): void | Promise<void>;
  onMessage?(event: ChannelMessageEvent): void | Promise<void>;
  onToolResult?(event: ChannelToolResultEvent): void | Promise<void>;
  onApprovalResponse?(
    event: ChannelApprovalResponseEvent
  ): void | Promise<void>;
  /** Observe a participant request to stop application work for one response. */
  onCancel?(event: ChannelCancelEvent): void | Promise<void>;
  /** Apply application-owned conversation reset policy. */
  onConversationReset?(
    event: ChannelConversationResetEvent
  ): void | Promise<void>;
};

type OutboundOperation = (
  channel: Channel,
  surface: ChannelMessageSurface
) => Promise<DeliveryResult>;

const POLICY_KEYS = new Set(["fallback", "fanout"]);

/**
 * Authenticates and normalizes ingress through configured Channel adapters,
 * resolves outbound surfaces, and awaits the application's durable handoff.
 */
export class ChannelHost {
  readonly #channels: Record<string, Channel>;
  readonly #streams: Streams | undefined;
  readonly #defaultRoute: ChannelRoute | undefined;
  readonly #findUser: ChannelHostOptions["findUser"];
  readonly #onRoute: ChannelHostOptions["onRoute"];
  readonly #onMessage: ChannelHostOptions["onMessage"];
  readonly #onToolResult: ChannelHostOptions["onToolResult"];
  readonly #onApprovalResponse: ChannelHostOptions["onApprovalResponse"];
  readonly #onCancel: ChannelHostOptions["onCancel"];
  readonly #onConversationReset: ChannelHostOptions["onConversationReset"];

  constructor(options: ChannelHostOptions) {
    for (const channelKey of Object.keys(options.channels)) {
      if (POLICY_KEYS.has(channelKey)) {
        throw new Error(
          `Channel key "${channelKey}" is reserved for a delivery policy`
        );
      }
    }
    const channels = { ...options.channels };
    this.#channels = channels;
    this.#streams = options.streams;
    const compositeResolver: OutboundResolver = {
      deliver: (surface, message, deliveryOptions) =>
        this.deliver(surface, message, deliveryOptions),
      stream: (surface, chunks, streamOptions = {}) =>
        this.#stream(surface, chunks, streamOptions, false),
      requestApproval: (surface, approvalOptions) =>
        this.requestApproval(surface, approvalOptions),
      isAvailable: (surface) => this.isAvailable(surface)
    };
    channels.fallback = fallbackChannel(compositeResolver);
    channels.fanout = fanoutChannel(compositeResolver);
    this.#defaultRoute = options.defaultRoute;
    this.#findUser = options.findUser;
    this.#onRoute = options.onRoute;
    this.#onMessage = options.onMessage;
    this.#onToolResult = options.onToolResult;
    this.#onApprovalResponse = options.onApprovalResponse;
    this.#onCancel = options.onCancel;
    this.#onConversationReset = options.onConversationReset;

    for (const [channelKey, channel] of Object.entries(options.channels)) {
      const bindHost = (channel as Channel & Partial<BindableChannelHost>)[
        bindChannelHost
      ];
      bindHost?.call(channel, {
        channelKey,
        resolveMessages: options.resolveMessages,
        responseStreams: options.streams
      });
      const bindIngress = (
        channel as Channel & Partial<BindableChannelIngress>
      )[bindChannelIngress];
      bindIngress?.call(channel, (envelope) =>
        this.#dispatch(channelKey, channel, envelope)
      );
    }
  }

  async handleRequest(request: Request): Promise<Response | undefined> {
    for (const [channelKey, channel] of Object.entries(this.#channels)) {
      const ingress = channel.ingress;
      if (!ingress) continue;

      try {
        const result = await ingress.receive(request);
        if (!result) continue;
        for (const envelope of result.events) {
          await this.#dispatch(channelKey, channel, envelope);
        }
        return result.response;
      } catch {
        return new Response("Failed to handle Channel event", { status: 500 });
      }
    }
    return undefined;
  }

  async handleEmail(email: ChannelEmailInput): Promise<boolean> {
    for (const [channelKey, channel] of Object.entries(this.#channels)) {
      const ingress = channel.emailIngress;
      if (!ingress) continue;

      const result = await ingress.receive(email);
      if (!result) continue;
      for (const envelope of result.events) {
        await this.#dispatch(channelKey, channel, envelope);
      }
      return true;
    }
    return false;
  }

  /** Deliver through the configured Channel or composite named by the surface. */
  deliver(
    surface: ChannelMessageSurface,
    message: ChannelMessage,
    options?: ChannelDeliveryOptions
  ): Promise<DeliveryResult> {
    return this.#outbound(surface, (channel, destination) => {
      if (!channel.deliver) {
        return Promise.resolve(
          unsupported(
            "CHANNEL_DELIVERY_UNSUPPORTED",
            `Channel "${destination.channelKey}" does not support delivery`
          )
        );
      }
      return channel.deliver(destination, message, options);
    });
  }

  /**
   * Deliver a progressively generated answer to the Channel or composite
   * named by the surface.
   *
   * A Channel that can stream consumes the stream itself. A Channel that
   * cannot never learns it was a stream, because the Host collects the answer
   * and calls `deliver` once.
   */
  stream(
    surface: ChannelMessageSurface,
    chunks: ChannelChunkSource,
    options: ChannelStreamOptions = {}
  ): Promise<DeliveryResult> {
    return this.#stream(surface, chunks, options, true);
  }

  async #stream(
    surface: ChannelMessageSurface,
    chunks: ChannelChunkSource,
    options: ChannelStreamOptions,
    record: boolean
  ): Promise<DeliveryResult> {
    if (!isChannelMessageSurface(surface)) {
      await chunks.cancel().catch(() => {});
      return invalidSurface();
    }

    const channel = this.#configuredChannel(surface.channelKey);
    if (!channel.stream && !channel.deliver) {
      await chunks.cancel().catch(() => {});
      return unsupported(
        "CHANNEL_DELIVERY_UNSUPPORTED",
        `Channel "${surface.channelKey}" does not support delivery`
      );
    }

    const recorded =
      record && this.#streams
        ? await this.#recordResponse(channel, surface, chunks, options)
        : chunks;
    try {
      if (channel.stream)
        return await channel.stream(surface, recorded, options);
      return await collectAndDeliver(channel, surface, recorded, options);
    } finally {
      if (recorded !== chunks) void recorded.cancel().catch(() => {});
    }
  }

  async #recordResponse(
    channel: Channel,
    surface: ChannelMessageSurface,
    chunks: ChannelChunkSource,
    options: ChannelStreamOptions
  ): Promise<ReadableStream<ChannelChunk>> {
    const response = options.response;
    if (!response) {
      await chunks.cancel().catch(() => {});
      throw new Error(
        "ChannelHost.stream requires options.response when Streams are configured"
      );
    }
    try {
      const describe = (
        channel as Channel & Partial<DescribableChannelResponse>
      )[describeChannelResponse];
      const channelMetadata = describe?.call(channel, surface, options);
      const writer = await this.#streams!.open(response.id, {
        tag: response.conversationId,
        metadata: {
          ...channelMetadata,
          owner: "channels",
          channelKey: surface.channelKey,
          conversationId: response.conversationId,
          messageId: response.messageId
        }
      });
      return recordedResponse(chunks, writer, response);
    } catch (error) {
      await chunks.cancel(error).catch(() => {});
      throw error;
    }
  }

  /** Request approval through the Channel or composite named by the surface. */
  requestApproval(
    surface: ChannelMessageSurface,
    options: ChannelApprovalRequestOptions
  ): Promise<DeliveryResult> {
    return this.#outbound(surface, (channel, destination) => {
      if (!channel.requestApproval) {
        return Promise.resolve(
          unsupported(
            "CHANNEL_APPROVAL_UNSUPPORTED",
            `Channel "${destination.channelKey}" does not support approval requests`
          )
        );
      }
      return channel.requestApproval(destination, options);
    });
  }

  /** Return the identity's configured Channel destination, when supported. */
  contactSurface(identity: ChannelIdentity): ChannelMessageSurface | null {
    const channel = Object.prototype.hasOwnProperty.call(
      this.#channels,
      identity.channelKey
    )
      ? this.#channels[identity.channelKey]
      : undefined;
    const surface = channel?.contactSurface?.(identity);
    return surface ? stampSurface(identity.channelKey, surface) : null;
  }

  /** Resolve whether a surface can currently be selected without delivery. */
  async isAvailable(surface: ChannelMessageSurface): Promise<boolean> {
    if (!isChannelMessageSurface(surface)) return false;
    const channel = this.#configuredChannel(surface.channelKey);
    return channel.isAvailable?.(surface) ?? true;
  }

  async #outbound(
    surface: ChannelMessageSurface,
    operation: OutboundOperation
  ): Promise<DeliveryResult> {
    if (!isChannelMessageSurface(surface)) return invalidSurface();
    const channel = this.#configuredChannel(surface.channelKey);
    return operation(channel, surface);
  }

  #configuredChannel(channelKey: string): Channel {
    const channel = Object.prototype.hasOwnProperty.call(
      this.#channels,
      channelKey
    )
      ? this.#channels[channelKey]
      : undefined;
    if (!channel) {
      throw new Error(
        `Channel message surface names unknown configured Channel key "${channelKey}"`
      );
    }
    return channel;
  }

  async #dispatch(
    channelKey: string,
    channel: Channel,
    envelope: ChannelIngressEnvelope
  ): Promise<ChannelIngressDispatchOutcome> {
    const rawEvent = envelope.event;
    const event = stampEvent(channelKey, rawEvent);
    const route = await this.#route(channelKey, channel, event, envelope.raw);
    const dispatchId = await createDispatchId(channelKey, event.eventId);
    await this.#onRoute?.({ channelKey, event, route, dispatchId });
    if (route === null) return "ignored";

    switch (event.type) {
      case "message": {
        if (!this.#onMessage) {
          throw new Error(
            `Channel "${channelKey}" received a message without an onMessage callback`
          );
        }
        await this.#onMessage({
          channelKey,
          route,
          dispatchId,
          message: event
        });
        return "handled";
      }
      case "tool-result": {
        if (!this.#onToolResult) {
          throw new Error(
            `Channel "${channelKey}" received a tool result without an onToolResult callback`
          );
        }
        await this.#onToolResult({
          channelKey,
          route,
          dispatchId,
          result: event
        });
        return "handled";
      }
      case "approval-response": {
        if (!this.#onApprovalResponse) {
          throw new Error(
            `Channel "${channelKey}" received an approval response without an onApprovalResponse callback`
          );
        }
        await this.#onApprovalResponse({
          channelKey,
          route,
          dispatchId,
          response: event
        });
        return "handled";
      }
      case "cancel-request": {
        if (!this.#onCancel) {
          throw new Error(
            `Channel "${channelKey}" received a cancellation request without an onCancel callback`
          );
        }
        await this.#onCancel({
          channelKey,
          route,
          dispatchId,
          request: event
        });
        return "handled";
      }
      case "conversation-reset-request": {
        if (!this.#onConversationReset) {
          throw new Error(
            `Channel "${channelKey}" received a conversation reset request without an onConversationReset callback`
          );
        }
        await this.#onConversationReset({
          channelKey,
          route,
          dispatchId,
          request: event
        });
        return "handled";
      }
    }
  }

  async #route(
    channelKey: string,
    channel: Channel,
    event: ChannelIngressEvent,
    raw: unknown
  ): Promise<string | null> {
    const context = this.#routeContext(event);
    const route = channel.route
      ? await channel.route(event, raw, context)
      : this.#defaultRoute
        ? await this.#defaultRoute(event, raw, context)
        : event.thread.id;

    if (route === undefined) {
      throw new Error(
        `Channel route for "${channelKey}" returned undefined; return null to ignore an event`
      );
    }
    if (route !== null && typeof route !== "string") {
      throw new Error(
        `Channel route for "${channelKey}" must return a string or null`
      );
    }
    return route;
  }

  #routeContext(event: ChannelIngressEvent): ChannelRouteContext {
    let linkedUser: Promise<UserIdentity | null> | undefined;
    return {
      findUser: () => {
        if (!linkedUser) {
          const identity = event.actor?.identity;
          const findUser = this.#findUser;
          linkedUser =
            identity && findUser
              ? Promise.resolve().then(() => findUser(identity))
              : Promise.resolve(null);
        }
        return linkedUser;
      }
    };
  }
}

function recordedResponse(
  source: ReadableStream<ChannelChunk>,
  writer: StreamWriter,
  response: ChannelResponseContext
): ReadableStream<ChannelChunk> {
  const reader = source.getReader();
  let first = true;
  let settled = false;
  let released = false;
  let partSequence = 0;
  let implicitPart: { type: "text" | "reasoning"; id: string } | undefined;

  function release(): void {
    if (released) return;
    released = true;
    reader.releaseLock();
  }

  function append(chunk: ChannelChunk): void {
    writer.append(chunk as unknown as import("../../streams").StreamJson);
  }

  function emit(
    controller: ReadableStreamDefaultController<ChannelChunk>,
    chunks: readonly ChannelChunk[]
  ): void {
    for (const chunk of chunks) {
      append(chunk);
      controller.enqueue(chunk);
    }
  }

  function fail(reason: unknown): void {
    if (settled) return;
    settled = true;
    writer.error(reason instanceof Error ? reason.message : String(reason));
  }

  function nextPartId(): string {
    partSequence += 1;
    return `${response.messageId}:part:${partSequence}`;
  }

  function closeImplicitPart(): ChannelChunk[] {
    if (!implicitPart) return [];
    const end = {
      type: implicitPart.type === "text" ? "text-end" : "reasoning-end",
      id: implicitPart.id
    } as ChannelChunk;
    implicitPart = undefined;
    return [end];
  }

  function normalizePart(chunk: ChannelChunk): ChannelChunk[] {
    if (chunk.type === "text" && chunk.id === undefined) {
      const normalized: ChannelChunk[] = [];
      if (implicitPart?.type !== "text") {
        normalized.push(...closeImplicitPart());
        implicitPart = { type: "text", id: nextPartId() };
        normalized.push({ type: "text-start", id: implicitPart.id });
      }
      normalized.push({ ...chunk, id: implicitPart.id });
      return normalized;
    }
    if (chunk.type === "reasoning" && chunk.id === undefined) {
      const normalized: ChannelChunk[] = [];
      if (implicitPart?.type !== "reasoning") {
        normalized.push(...closeImplicitPart());
        implicitPart = { type: "reasoning", id: nextPartId() };
        normalized.push({ type: "reasoning-start", id: implicitPart.id });
      }
      normalized.push({ ...chunk, id: implicitPart.id });
      return normalized;
    }

    const normalized = closeImplicitPart();
    if (
      (chunk.type === "tool" ||
        chunk.type === "source" ||
        chunk.type === "data") &&
      chunk.id === undefined
    ) {
      normalized.push({ ...chunk, id: nextPartId() });
    } else {
      normalized.push(chunk);
    }
    return normalized;
  }

  function normalize(chunk: ChannelChunk): ChannelChunk[] {
    if (first) {
      first = false;
      if (chunk.type === "message-start") {
        if (
          chunk.messageId !== undefined &&
          chunk.messageId !== response.messageId
        ) {
          throw new Error(
            `Channel response message ID ${JSON.stringify(response.messageId)} does not match stream message ID ${JSON.stringify(chunk.messageId)}`
          );
        }
        return [{ ...chunk, messageId: response.messageId }];
      }
      return [
        { type: "message-start", messageId: response.messageId },
        ...normalizePart(chunk)
      ];
    }
    if (chunk.type === "message-start") {
      throw new Error("A Channel response stream can contain one message");
    }
    return normalizePart(chunk);
  }

  return new ReadableStream<ChannelChunk>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          const finalChunks: ChannelChunk[] = [];
          if (first) {
            finalChunks.push({
              type: "message-start",
              messageId: response.messageId
            });
          }
          finalChunks.push(...closeImplicitPart());
          emit(controller, finalChunks);
          settled = true;
          writer.close();
          release();
          controller.close();
          return;
        }

        emit(controller, normalize(next.value));
      } catch (error) {
        fail(error);
        await reader.cancel(error).catch(() => {});
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      fail(reason ?? "Channel stopped reading the response");
      await reader.cancel(reason).catch(() => {});
      release();
    }
  });
}

/**
 * Serve a Channel that cannot stream by collecting the answer first.
 *
 * A generation that failed part-way still delivers what it produced, because
 * losing the partial answer helps nobody, but the result is downgraded to
 * `uncertain` since the reader received an incomplete answer.
 */
function invalidSurface(): DeliveryResult {
  return unsupported(
    "CHANNEL_SURFACE_INVALID",
    "Cannot resolve an invalid Channel message surface"
  );
}

async function collectAndDeliver(
  channel: Channel,
  surface: ChannelMessageSurface,
  stream: ReadableStream<ChannelChunk>,
  options: ChannelStreamOptions
): Promise<DeliveryResult> {
  const collected = await collectText(stream);
  if (collected.interrupted && collected.text.length === 0) {
    return {
      status: "failed",
      retryable: false,
      error: {
        code: "CHANNEL_STREAM_INTERRUPTED",
        message: "The stream ended before producing any content to deliver"
      }
    };
  }

  const result = await channel.deliver!(
    surface,
    {
      ...(options.title !== undefined && { title: options.title }),
      markdown: collected.text
    },
    options.delivery ? { delivery: options.delivery } : undefined
  );
  if (!collected.interrupted || result.status !== "delivered") return result;
  return {
    status: "uncertain",
    ...(result.reference !== undefined && { reference: result.reference }),
    error: {
      code: "CHANNEL_STREAM_INTERRUPTED",
      message:
        "An incomplete answer was delivered because the stream ended early"
    }
  };
}

function stampSurface<TAddress extends ChannelMessageSurfaceInput["address"]>(
  channelKey: string,
  surface: ChannelMessageSurfaceInput<TAddress>
): ChannelMessageSurface<string, TAddress> {
  return { ...surface, channelKey };
}

function stampIdentity(
  channelKey: string,
  identity: ChannelIdentityInput
): ChannelIdentity {
  return { ...identity, channelKey };
}

function stampEvent(
  channelKey: string,
  event: ChannelIngressEventInput
): ChannelIngressEvent {
  return {
    ...event,
    ...(event.replySurface && {
      replySurface: stampSurface(channelKey, event.replySurface)
    }),
    ...(event.actor && {
      actor: {
        ...event.actor,
        ...(event.actor.identity && {
          identity: stampIdentity(channelKey, event.actor.identity)
        })
      }
    })
  } as ChannelIngressEvent;
}

/** Hash an unambiguous tuple so dispatch identities remain safe to carry. */
async function createDispatchId(
  channelKey: string,
  eventId: string
): Promise<string> {
  const identity = new TextEncoder().encode(
    JSON.stringify([channelKey, eventId])
  );
  const digest = await crypto.subtle.digest("SHA-256", identity);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}
