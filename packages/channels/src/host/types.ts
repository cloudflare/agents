import type { DurableObjectAlarmScheduler } from "../alarm-coordinator";
import type {
  Channel,
  ChannelApprovalRequest,
  ChannelMessage,
  DeliveryResult
} from "../channel";
import type {
  ChannelApprovalResponse,
  ChannelInboundMessage
} from "../ingress";

export class ChannelApprovalConflictError extends Error {
  constructor(message = "Approval interaction is already settled") {
    super(message);
    this.name = "ChannelApprovalConflictError";
  }
}

export type ChannelApprovalResponseEvent = {
  channelId: string;
  interactionId: string;
  decision: ChannelApprovalResponse["decision"];
  reference: string;
  sender?: ChannelApprovalResponse["sender"];
};

export type ChannelHostStorage = Pick<
  DurableObjectStorage,
  "delete" | "deleteAlarm" | "get" | "list" | "put" | "setAlarm" | "transaction"
>;

export type ChannelHostScheduler = DurableObjectAlarmScheduler;

export type ChannelHostOptions = {
  channels: Record<string, Channel>;
  storage: ChannelHostStorage;
  approvalRequests?: string;
  delivery?: string;
  /** Public URL for this Host, including any Agent route prefix. */
  publicBaseUrl?: string;
  /** Route-relative path for Host-owned approval links. */
  approvalLinkPath?: string;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  /**
   * Durable retry scheduler. Omit when this Host exclusively owns the Durable
   * Object's native alarm; call `handleAlarm()` from the DO alarm handler.
   */
  scheduler?: ChannelHostScheduler;
  onApprovalResponse(event: ChannelApprovalResponseEvent): void | Promise<void>;
  onMessage?(event: {
    channelId: string;
    message: ChannelInboundMessage;
  }): void | Promise<void>;
};

export type HostedDeliveryResult = {
  deliveryId: string;
  channelId: string;
  result: DeliveryResult;
};

export type HostedMessageOptions = {
  deliveryId?: string;
  message: ChannelMessage;
};

export type StoredApprovalLinks = {
  approveToken: string;
  rejectToken: string;
};

export type StoredApprovalResponse = {
  decision: ChannelApprovalResponse["decision"];
  channelId: string;
  reference: string;
  receivedAt: number;
};

export type StoredDelivery = {
  id: string;
  kind: "message" | "approval";
  channelId: string;
  message?: ChannelMessage;
  interactionId?: string;
  request?: ChannelApprovalRequest;
  status: "pending" | "attempting" | "retry-wait" | DeliveryResult["status"];
  attempt: number;
  result?: DeliveryResult;
  nextAttemptAt?: number;
  providerReference?: string;
  approvalLinks?: StoredApprovalLinks;
  response?: StoredApprovalResponse;
  createdAt: number;
  updatedAt: number;
};

export type StoredApprovalLink = {
  interactionId: string;
  decision: ChannelApprovalResponse["decision"];
};

export type StoredReference = {
  kind: "approval";
  interactionId: string;
};
