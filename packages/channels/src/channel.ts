import type { ChannelEmailIngress, ChannelIngress } from "./ingress";

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

/** A stable Host identity supplied to one provider delivery attempt. */
export type ChannelDeliveryContext = {
  deliveryId: string;
  attempt: number;
};

/** Host-owned approval links a Channel may include in its rendering. */
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
  /** Stable identity for provider idempotency and delivery observability. */
  delivery?: ChannelDeliveryContext;
  /** Lazily creates one durable pair of Host-owned approval links. */
  getApprovalLinks?: () => Promise<ChannelApprovalLinks>;
};

/** A configured delivery route with optional approval and ingress support. */
export interface Channel {
  /**
   * Whether this route can currently be selected without attempting delivery.
   * Absence means the channel should be attempted.
   */
  isAvailable?(): boolean | Promise<boolean>;
  deliver(
    message: ChannelMessage,
    context?: ChannelDeliveryContext
  ): Promise<DeliveryResult>;
  requestApproval?(
    options: ChannelApprovalRequestOptions
  ): Promise<DeliveryResult>;
  readonly ingress?: ChannelIngress;
  readonly emailIngress?: ChannelEmailIngress;
}

/** The ordinary delivery surface accepted by model tool adapters. */
export type ChannelDelivery = Pick<Channel, "deliver">;
