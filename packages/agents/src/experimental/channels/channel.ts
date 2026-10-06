import type {
  ChannelEmailIngress,
  ChannelIngress,
  ChannelIngressEvent
} from "./ingress";
import type { ChannelIdentity } from "./identity";
import type { Participant, ResponseChunk } from "./protocol";
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

/**
 * Who a sender is, as the application decides it. A string is shorthand
 * for `{ id }`; `null` refuses the sender. Participants that share an id
 * are the same participant.
 */
export type ParticipantResult = Participant | string | null;

/**
 * Resolve who sent an authenticated event. Channels has no opinion on
 * identity: this is the only place a webhook sender becomes a participant.
 */
export type ChannelParticipant<TRaw = unknown> = (
  event: ChannelIngressEvent,
  raw: TRaw
) => Awaitable<ParticipantResult>;

/**
 * Pick the agent object an event reaches, or return null to ignore it.
 *
 * The agent object is the authorization boundary: anyone who reaches one
 * may use every conversation in it. Default: an agent object of the
 * participant's own (`routes.perParticipant`).
 */
export type ChannelRoute<TRaw = unknown> = (
  event: ChannelIngressEvent,
  raw: TRaw,
  participant: Participant
) => Awaitable<string | null>;

/** A WebSocket upgrade's conversation, once it is known to be for Channels. */
export type ChannelUpgradeMatch = {
  /** The conversation to follow. Default: the agent's default conversation. */
  conversationId?: string;
};

/** How a Channel takes WebSocket upgrades in the gateway. */
export interface ChannelUpgrade {
  /** Return undefined for an upgrade that is not for this Channel. */
  match(request: Request): ChannelUpgradeMatch | undefined;
  /** Who is connecting. Return null to refuse the upgrade. */
  participant(request: Request): Awaitable<ParticipantResult>;
  /** The agent object the upgrade reaches, or null to refuse it. */
  route(request: Request, participant: Participant): Awaitable<string | null>;
}

/** A configured delivery route with optional ingress support. */
export interface Channel<TRaw = unknown> {
  /**
   * Who sent an ingress event. Required when the Channel has `ingress` or
   * `emailIngress`; the gateway refuses to start without it.
   */
  participant?(
    event: ChannelIngressEvent,
    raw: TRaw
  ): Awaitable<ParticipantResult>;
  /** Pick the agent object an event reaches. See `ChannelRoute`. */
  route?(
    event: ChannelIngressEvent,
    raw: TRaw,
    participant: Participant
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
  /** WebSocket upgrades this Channel takes, such as the Web Channel's. */
  readonly upgrade?: ChannelUpgrade;
}
