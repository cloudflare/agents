import type { ChannelIdentity, ChannelIdentityInput } from "./identity";
import type {
  ChannelMessageSurface,
  ChannelMessageSurfaceInput
} from "./surface";

/** Serializable provider attachment facts available after ingress returns. */
export type ChannelAttachment = {
  id?: string;
  mediaType?: string;
  name?: string;
  size?: number;
  text?: string;
  url?: string;
};

export type ChannelActor = {
  readonly id: string;
  /** Stable Channel identity suitable for explicit application linking. */
  readonly identity?: ChannelIdentity;
  readonly username?: string;
  readonly fullName?: string;
  readonly isBot?: boolean | "unknown";
  readonly isSelf?: boolean;
};

/** An actor before the Router stamps its configured Channel key. */
export type ChannelActorInput = Omit<ChannelActor, "identity"> & {
  readonly identity?: ChannelIdentityInput;
};

export type ChannelEventContext = {
  /** Immutable Channel-scoped identity, independent of application routing. */
  readonly eventId: string;
  readonly thread: {
    readonly id: string;
    readonly isDirectMessage: boolean | "unknown";
  };
  /** Exact provider destination for responding to this inbound event. */
  readonly replySurface?: ChannelMessageSurface;
  readonly actor?: ChannelActor;
};

/** A normalized inbound message from a Channel adapter. */
export type ChannelInboundMessage = ChannelEventContext & {
  readonly type: "message";
  readonly message: {
    readonly id: string;
    readonly text: string;
    readonly title?: string;
    readonly markdown?: string;
    readonly attachments?: readonly ChannelAttachment[];
    readonly isMention?: boolean;
    readonly reply?: {
      readonly id: string;
      readonly text?: string;
    };
    readonly metadata?: {
      /** ISO 8601 timestamp supplied by the provider. */
      readonly sentAt?: string;
      readonly edited?: boolean;
      /** ISO 8601 timestamp supplied by the provider. */
      readonly editedAt?: string;
      readonly autoReply?: boolean;
    };
  };
};

/** A provider-normalized response to an external approval request. */
export type ChannelApprovalResponse = ChannelEventContext & {
  readonly type: "approval-response";
  readonly interactionId: string;
  readonly decision: "approve" | "reject";
  /** Provider reference for this inbound response. */
  readonly reference: string;
};

export type ChannelIngressEvent =
  | ChannelInboundMessage
  | ChannelApprovalResponse;

/** A normalized message before the Router stamps its configured Channel key. */
export type ChannelEventContextInput = Omit<
  ChannelEventContext,
  "replySurface" | "actor"
> & {
  readonly replySurface?: ChannelMessageSurfaceInput;
  readonly actor?: ChannelActorInput;
};

export type ChannelInboundMessageInput = Omit<
  ChannelInboundMessage,
  "replySurface" | "actor"
> & {
  readonly replySurface?: ChannelMessageSurfaceInput;
  readonly actor?: ChannelActorInput;
};

/** A normalized approval before the Router stamps its configured Channel key. */
export type ChannelApprovalResponseInput = Omit<
  ChannelApprovalResponse,
  "replySurface" | "actor"
> & {
  readonly replySurface?: ChannelMessageSurfaceInput;
  readonly actor?: ChannelActorInput;
};

/** Authenticated event produced by a Channel before Router dispatch. */
export type ChannelIngressEventInput =
  | ChannelInboundMessageInput
  | ChannelApprovalResponseInput;

/** Authenticated adapter output retained only until Router routing completes. */
export type ChannelIngressEnvelope<TRaw = unknown> = {
  event: ChannelIngressEventInput;
  raw: TRaw;
};

/** The normalized envelopes and provider acknowledgement produced by ingress. */
export type ChannelIngressResult<TRaw = unknown> = {
  events: readonly ChannelIngressEnvelope<TRaw>[];
  response: Response;
};

/** Match an HTTP request to one exact URL pathname. */
export function matchesPath(request: Request, path: string): boolean {
  return new URL(request.url).pathname === path;
}

/** Webhook-shaped inbound support owned by a Channel. */
export interface ChannelIngress<TRaw = unknown> {
  /** Return null when this Channel does not own the request. */
  receive(request: Request): Promise<ChannelIngressResult<TRaw> | null>;
}

/** Structural input supported by Workers Email and Agent email handlers. */
export type ChannelEmailInput = {
  from: string;
  to: string;
  headers: Headers;
  raw?: ReadableStream<Uint8Array>;
  getRaw?: () => Promise<Uint8Array>;
};

export type ChannelEmailIngressResult<TRaw = unknown> = {
  events: readonly ChannelIngressEnvelope<TRaw>[];
};

/** Non-HTTP ingress for a Workers Email event. */
export interface ChannelEmailIngress<TRaw = unknown> {
  /** Return null when this Channel does not own the email. */
  receive(
    email: ChannelEmailInput
  ): Promise<ChannelEmailIngressResult<TRaw> | null>;
}
