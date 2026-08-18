/** A normalized inbound text message from a Channel webhook. */
export type ChannelInboundMessage = {
  type: "message";
  text: string;
  /** Provider reference for this inbound message. */
  reference: string;
  /** The outbound or inbound message this message replies to. */
  replyTo?: {
    reference: string;
    text?: string;
  };
  sender?: {
    id: string;
    username?: string;
  };
};

/** A provider-normalized response to an external approval request. */
export type ChannelApprovalResponse = {
  type: "approval-response";
  decision: "approve" | "reject";
  /** Provider reference for this inbound response. */
  reference: string;
  /** Interaction recovered from provider-specific approval content. */
  interactionId?: string;
  /** Provider reference for the approval request being answered. */
  replyToReference?: string;
  sender?: ChannelInboundMessage["sender"];
};

export type ChannelIngressEvent =
  | ChannelInboundMessage
  | ChannelApprovalResponse;

/** The normalized events and provider acknowledgement produced by ingress. */
export type ChannelIngressResult = {
  events: readonly ChannelIngressEvent[];
  response: Response;
};

/** Webhook-shaped inbound support owned by a Channel. */
export interface ChannelIngress {
  /** Path mounted by the ChannelHost. */
  readonly path: string;
  receive(request: Request): Promise<ChannelIngressResult>;
}

/** Structural input supported by Workers Email and Agent email handlers. */
export type ChannelEmailInput = {
  from: string;
  to: string;
  headers: Headers;
  raw?: ReadableStream<Uint8Array>;
  getRaw?: () => Promise<Uint8Array>;
};

export type ChannelEmailIngressResult = {
  events: readonly ChannelIngressEvent[];
};

/** Non-HTTP ingress for a Workers Email event. */
export interface ChannelEmailIngress {
  accepts?(email: ChannelEmailInput): boolean;
  receive(email: ChannelEmailInput): Promise<ChannelEmailIngressResult>;
}
