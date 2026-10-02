import type {
  ChannelEmailIngress,
  ChannelIngress,
  ChannelIngressEvent
} from "./ingress";
import type { ChannelIdentity, UserIdentity } from "./identity";
import type { ResponseChunk } from "./protocol";
import type {
  ChannelMessageSurface,
  ChannelMessageSurfaceInput
} from "./surface";

export type Awaitable<T> = T | Promise<T>;

/** A transport-neutral outbound message whose canonical content is Markdown. */
export type ChannelMessage = {
  /** Optional topic. Each transport decides how to represent it. */
  title?: string;
  /** Canonical Markdown content. */
  markdown: string;
};

/** A transport failure safe to expose to an AI model. */
export type DeliveryFailure = {
  code: string;
  message: string;
};

/**
 * The result of a direct delivery attempt, defined by what reached the reader.
 *
 * `delivered` means the whole message reached the reader, not that a person
 * read it. `failed` means none of it did; its `retryable` field says whether
 * the same route can be attempted again. `uncertain` means an unknown amount
 * of the message reached the reader, so another attempt or route could
 * duplicate content. A stream that ends before its answer is complete is
 * `uncertain`, and carries a `reference` when the Channel created something
 * the caller can point at.
 */
export type DeliveryResult =
  | {
      status: "delivered";
      reference?: string;
    }
  | {
      status: "failed";
      retryable: boolean;
      error: DeliveryFailure;
    }
  | {
      status: "uncertain";
      reference?: string;
      error: DeliveryFailure;
    };

/** A response's chunks, as `ChannelGateway.stream` takes them. */
export type ChannelChunkSource = ReadableStream<ResponseChunk>;

/** Caller options for one finished delivery. */
export type ChannelDeliveryOptions = {
  /** Caller-owned correlation an Adapter may use where the provider supports it. */
  delivery?: ChannelDeliveryContext;
};

/** Caller options for one streamed answer. */
export type ChannelStreamOptions = {
  /**
   * Optional topic. It is an option rather than a chunk because it is known
   * before the first token, and a Channel usually needs it in its opening
   * provider call.
   */
  title?: string;
  /** Caller-owned correlation an Adapter may use where the provider supports it. */
  delivery?: ChannelDeliveryContext;
};

/**
 * Caller-owned correlation supplied to one provider delivery attempt.
 *
 * This is not an idempotency guarantee. An Adapter may map it to a provider
 * idempotency primitive when one exists, or otherwise use it for observability.
 */
export type ChannelDeliveryContext = {
  deliveryId: string;
};

export type ChannelRouteContext = {
  /** Lazily resolve the application user explicitly linked to the event actor. */
  findUser(): Promise<UserIdentity | null>;
};

export type ChannelRoute<TRaw = unknown> = (
  event: ChannelIngressEvent,
  raw: TRaw,
  context: ChannelRouteContext
) => Awaitable<string | null>;

/** A configured delivery route with optional ingress support. */
export interface Channel<TRaw = unknown> {
  /** Select an opaque application route, or return null to ignore the event. */
  route?(
    event: ChannelIngressEvent,
    raw: TRaw,
    context: ChannelRouteContext
  ): Awaitable<string | null>;
  /** Derive a direct destination from this configured Channel's identity. */
  contactSurface?(identity: ChannelIdentity): ChannelMessageSurfaceInput | null;
  /**
   * Deliver one finished message. Only for Channels that cannot stream:
   * the gateway delivers to a Channel that can by streaming the message.
   */
  deliver?(
    surface: ChannelMessageSurface,
    message: ChannelMessage,
    options?: ChannelDeliveryOptions
  ): Promise<DeliveryResult>;
  /**
   * Deliver one progressively generated answer. Absent for Channels that
   * cannot stream, which the Host serves by collecting and calling `deliver`.
   *
   * The Channel owns the consumption loop. It must finalize whether the
   * stream closed or errored, because a model can fail mid-generation, and it
   * must not abandon a terminal provider call on error.
   */
  stream?(
    surface: ChannelMessageSurface,
    chunks: ChannelChunkSource,
    options: ChannelStreamOptions
  ): Promise<DeliveryResult>;
  readonly ingress?: ChannelIngress<TRaw>;
  readonly emailIngress?: ChannelEmailIngress<TRaw>;
}
