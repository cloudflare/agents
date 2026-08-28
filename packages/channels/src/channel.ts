import type {
  ChannelEmailIngress,
  ChannelIngress,
  ChannelIngressEvent
} from "./ingress";
import type { ChannelIdentity, UserIdentity } from "./identity";
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

/**
 * One element of a progressively generated answer.
 *
 * The variants describe what an Agent produces, not what a provider renders.
 * Any Channel may ignore any variant, so `text` alone must always be a
 * complete answer; a variant carrying meaning `text` does not is a bug in the
 * variant.
 */
export type ChannelChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      name: string;
      status: "started" | "completed" | "failed";
      title?: string;
      detail?: string;
    }
  | { type: "source"; url: string; title?: string };

/** The normalized stream shape accepted by `ChannelHost.stream`. */
export type ChannelChunkSource = ReadableStream<ChannelChunk>;

/** Caller options for one finished delivery. */
export type ChannelDeliveryOptions = {
  /** Caller-owned identity for provider idempotency and observability. */
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
  /** Caller-owned identity for provider idempotency and observability. */
  delivery?: ChannelDeliveryContext;
};

/** A caller-owned identity supplied to one provider delivery attempt. */
export type ChannelDeliveryContext = {
  deliveryId: string;
};

/** Caller-supplied approval links a Channel may include in its rendering. */
export type ChannelApprovalLinks = {
  approve: string;
  reject: string;
};

/** The content a Channel needs to render an external approval request. */
export type ChannelApprovalRequest = {
  title?: string;
  summary: string;
  input: unknown;
};

export type ChannelApprovalRequestOptions = {
  interactionId: string;
  request: ChannelApprovalRequest;
  /** Caller-owned identity for provider idempotency and observability. */
  delivery?: ChannelDeliveryContext;
  /** Lazily obtains approval links supplied and settled by the caller. */
  getApprovalLinks?: () => Promise<ChannelApprovalLinks>;
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

/** Recursive outbound capability injected into a composite Channel. */
export type OutboundResolver = {
  deliver(
    surface: ChannelMessageSurface,
    message: ChannelMessage,
    options?: ChannelDeliveryOptions
  ): Promise<DeliveryResult>;
  stream(
    surface: ChannelMessageSurface,
    chunks: ChannelChunkSource,
    options?: ChannelStreamOptions
  ): Promise<DeliveryResult>;
  requestApproval(
    surface: ChannelMessageSurface,
    options: ChannelApprovalRequestOptions
  ): Promise<DeliveryResult>;
  isAvailable(surface: ChannelMessageSurface): Promise<boolean>;
};

/** A configured delivery route with optional approval and ingress support. */
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
   * Whether this route can currently be selected without attempting delivery.
   * Absence means the channel should be attempted.
   */
  isAvailable?(surface: ChannelMessageSurface): Awaitable<boolean>;
  /**
   * Perform one outbound delivery. Absent for inbound-only Channels.
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
    chunks: ReadableStream<ChannelChunk>,
    options: ChannelStreamOptions
  ): Promise<DeliveryResult>;
  requestApproval?(
    surface: ChannelMessageSurface,
    options: ChannelApprovalRequestOptions
  ): Promise<DeliveryResult>;
  readonly ingress?: ChannelIngress<TRaw>;
  readonly emailIngress?: ChannelEmailIngress<TRaw>;
}
