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
 * The result of a direct delivery attempt.
 *
 * `delivered` means the transport accepted the message, not that a person read
 * it. `failed` means the transport confirmed that no delivery occurred; its
 * `retryable` field says whether the same route can be attempted again.
 * `uncertain` means another attempt or route could produce a duplicate.
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
      error: DeliveryFailure;
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
    context?: ChannelDeliveryContext
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
    context?: ChannelDeliveryContext
  ): Promise<DeliveryResult>;
  requestApproval?(
    surface: ChannelMessageSurface,
    options: ChannelApprovalRequestOptions
  ): Promise<DeliveryResult>;
  readonly ingress?: ChannelIngress<TRaw>;
  readonly emailIngress?: ChannelEmailIngress<TRaw>;
}
