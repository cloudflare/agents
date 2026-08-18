import type { DurableObjectAlarmSourceTransaction } from "../alarm-coordinator";
import type {
  Channel,
  ChannelApprovalLinks,
  ChannelApprovalRequest,
  ChannelMessage,
  DeliveryResult
} from "../channel";
import type { ChannelApprovalResponse } from "../ingress";
import {
  APPROVAL_ROUTE_KEY,
  DELIVERY_PREFIX,
  DELIVERY_ROUTE_KEY,
  approvalDeliveryId,
  deliveryKey,
  getDelivery,
  getSettlement,
  putDelivery,
  referenceKey,
  settlementKey
} from "./storage";
import type {
  ChannelHostScheduler,
  ChannelHostStorage,
  HostedDeliveryResult,
  HostedMessageOptions,
  StoredApprovalResponse,
  StoredDelivery,
  StoredReference
} from "./types";

export type DeliveryController = {
  initialize(reconcileRetrySchedules: boolean): Promise<void>;
  setApprovalRequestsChannel(channelId?: string): Promise<void>;
  setDeliveryChannel(channelId?: string): Promise<void>;
  deliver(
    options: HostedMessageOptions
  ): Promise<HostedDeliveryResult | undefined>;
  requestApproval(options: {
    interactionId: string;
    request: ChannelApprovalRequest;
  }): Promise<HostedDeliveryResult | undefined>;
  retryDelivery(deliveryId: string): Promise<HostedDeliveryResult>;
  handleDueDeliveries(deliveryIds?: readonly string[]): Promise<void>;
  settleApproval(
    interactionId: string,
    decision: ChannelApprovalResponse["decision"],
    channelId?: string
  ): Promise<void>;
  getHostedDelivery(
    deliveryId: string
  ): Promise<HostedDeliveryResult | undefined>;
};

export function createDeliveryController(options: {
  channels: Record<string, Channel>;
  storage: ChannelHostStorage;
  scheduler: ChannelHostScheduler;
  configuredApprovalChannelId?: string;
  configuredDeliveryChannelId?: string;
  maxAttempts: number;
  retryBaseDelayMs: number;
  approvalLinksAvailable: boolean;
  getApprovalLinks(deliveryId: string): Promise<ChannelApprovalLinks>;
}): DeliveryController {
  const inFlightDeliveries = new Map<string, Promise<HostedDeliveryResult>>();
  let approvalRequestsChannelId: string | undefined;
  let deliveryChannelId: string | undefined;

  async function initialize(reconcileRetrySchedules: boolean): Promise<void> {
    approvalRequestsChannelId =
      (await options.storage.get<string>(APPROVAL_ROUTE_KEY)) ??
      options.configuredApprovalChannelId;
    deliveryChannelId =
      (await options.storage.get<string>(DELIVERY_ROUTE_KEY)) ??
      options.configuredDeliveryChannelId;
    validateChannelId(approvalRequestsChannelId);
    validateChannelId(deliveryChannelId);

    const deliveries = await options.storage.list<StoredDelivery>({
      prefix: DELIVERY_PREFIX
    });
    for (const delivery of deliveries.values()) {
      if (delivery.providerReference && delivery.interactionId) {
        await options.storage.put(
          referenceKey(delivery.channelId, delivery.providerReference),
          {
            kind: "approval",
            interactionId: delivery.interactionId
          } satisfies StoredReference
        );
      }
      if (delivery.status === "attempting") {
        const result = uncertain(
          "The previous delivery attempt was interrupted before its outcome was recorded"
        );
        await putDelivery(options.storage, {
          ...delivery,
          status: result.status,
          result,
          updatedAt: Date.now()
        });
      } else if (delivery.status === "pending") {
        void attempt(delivery.id);
      } else if (
        reconcileRetrySchedules &&
        delivery.status === "retry-wait" &&
        delivery.nextAttemptAt !== undefined
      ) {
        await options.scheduler.schedule(delivery.id, delivery.nextAttemptAt);
      }
    }
  }

  async function setApprovalRequestsChannel(channelId?: string): Promise<void> {
    validateChannelId(channelId);
    approvalRequestsChannelId =
      channelId ?? options.configuredApprovalChannelId;
    if (channelId === undefined) {
      await options.storage.delete(APPROVAL_ROUTE_KEY);
    } else {
      await options.storage.put(APPROVAL_ROUTE_KEY, channelId);
    }
  }

  async function setDeliveryChannel(channelId?: string): Promise<void> {
    validateChannelId(channelId);
    deliveryChannelId = channelId ?? options.configuredDeliveryChannelId;
    if (channelId === undefined) {
      await options.storage.delete(DELIVERY_ROUTE_KEY);
    } else {
      await options.storage.put(DELIVERY_ROUTE_KEY, channelId);
    }
  }

  async function deliver(
    messageOptions: HostedMessageOptions
  ): Promise<HostedDeliveryResult | undefined> {
    const channelId = deliveryChannelId;
    if (!channelId) return undefined;

    const id = messageOptions.deliveryId ?? crypto.randomUUID();
    const existing = await getDelivery(options.storage, id);
    if (existing) {
      assertSameDelivery(existing, channelId, messageOptions.message);
      const inFlight = inFlightDeliveries.get(id);
      if (inFlight) return inFlight;
      return existing.status === "pending"
        ? attempt(id)
        : hostedResult(existing);
    }

    const now = Date.now();
    await putDelivery(options.storage, {
      id,
      kind: "message",
      channelId,
      message: messageOptions.message,
      status: "pending",
      attempt: 0,
      createdAt: now,
      updatedAt: now
    });
    return attempt(id);
  }

  async function requestApproval(requestOptions: {
    interactionId: string;
    request: ChannelApprovalRequest;
  }): Promise<HostedDeliveryResult | undefined> {
    const channelId = approvalRequestsChannelId;
    if (!channelId) return undefined;
    const id = approvalDeliveryId(requestOptions.interactionId);
    const settlement = await getSettlement(
      options.storage,
      requestOptions.interactionId
    );
    if (settlement) {
      return {
        deliveryId: id,
        channelId,
        result: {
          status: "failed",
          retryable: false,
          error: {
            code: "INTERACTION_ALREADY_SETTLED",
            message: `Interaction "${requestOptions.interactionId}" is already settled`
          }
        }
      };
    }
    const existing = await getDelivery(options.storage, id);
    if (existing) {
      assertSameApproval(
        existing,
        channelId,
        requestOptions.interactionId,
        requestOptions.request
      );
      const inFlight = inFlightDeliveries.get(id);
      if (inFlight) return inFlight;
      return existing.status === "pending"
        ? attempt(id)
        : hostedResult(existing);
    }

    const now = Date.now();
    await putDelivery(options.storage, {
      id,
      kind: "approval",
      channelId,
      interactionId: requestOptions.interactionId,
      request: requestOptions.request,
      status: "pending",
      attempt: 0,
      createdAt: now,
      updatedAt: now
    });
    return attempt(id);
  }

  async function retryDelivery(
    deliveryId: string
  ): Promise<HostedDeliveryResult> {
    const delivery = await getDelivery(options.storage, deliveryId);
    if (!delivery) throw new Error(`Unknown delivery "${deliveryId}"`);
    if (delivery.status !== "retry-wait") return hostedResult(delivery);
    if (
      delivery.nextAttemptAt !== undefined &&
      delivery.nextAttemptAt > Date.now()
    ) {
      await options.scheduler.schedule(deliveryId, delivery.nextAttemptAt);
      return hostedResult(delivery);
    }
    return attempt(deliveryId);
  }

  async function handleDueDeliveries(
    deliveryIds?: readonly string[]
  ): Promise<void> {
    const now = Date.now();
    const deliveries = deliveryIds
      ? await deliveriesById(deliveryIds)
      : [
          ...(
            await options.storage.list<StoredDelivery>({
              prefix: DELIVERY_PREFIX
            })
          ).values()
        ];

    for (const delivery of deliveries) {
      if (
        delivery.status !== "retry-wait" ||
        delivery.nextAttemptAt === undefined
      ) {
        continue;
      }
      if (delivery.nextAttemptAt <= now) {
        await attempt(delivery.id);
      } else {
        // This also reconciles future work if a non-transactional scheduler
        // previously failed after retry state was persisted.
        await options.scheduler.schedule(delivery.id, delivery.nextAttemptAt);
      }
    }
  }

  async function settleApproval(
    interactionId: string,
    decision: ChannelApprovalResponse["decision"],
    channelId = "application"
  ): Promise<void> {
    const existing = await getSettlement(options.storage, interactionId);
    if (existing) return;
    const response: StoredApprovalResponse = {
      decision,
      channelId,
      reference: `${channelId}:${interactionId}`,
      receivedAt: Date.now()
    };
    await options.storage.put(settlementKey(interactionId), response);
    const delivery = await getDelivery(
      options.storage,
      approvalDeliveryId(interactionId)
    );
    if (!delivery || delivery.response) return;
    await putDelivery(options.storage, {
      ...delivery,
      response,
      updatedAt: Date.now()
    });
  }

  async function getHostedDelivery(
    deliveryId: string
  ): Promise<HostedDeliveryResult | undefined> {
    const delivery = await getDelivery(options.storage, deliveryId);
    return delivery ? hostedResult(delivery) : undefined;
  }

  function validateChannelId(channelId: string | undefined): void {
    if (channelId !== undefined && !options.channels[channelId]) {
      throw new Error(`Unknown channel "${channelId}"`);
    }
  }

  async function deliveriesById(
    ids: readonly string[]
  ): Promise<StoredDelivery[]> {
    const deliveries: StoredDelivery[] = [];
    for (const id of new Set(ids)) {
      const delivery = await getDelivery(options.storage, id);
      if (delivery) deliveries.push(delivery);
    }
    return deliveries;
  }

  async function attempt(deliveryId: string): Promise<HostedDeliveryResult> {
    const inFlight = inFlightDeliveries.get(deliveryId);
    if (inFlight) return inFlight;

    const deliveryAttempt = performAttempt(deliveryId);
    inFlightDeliveries.set(deliveryId, deliveryAttempt);
    try {
      return await deliveryAttempt;
    } finally {
      if (inFlightDeliveries.get(deliveryId) === deliveryAttempt) {
        inFlightDeliveries.delete(deliveryId);
      }
    }
  }

  async function performAttempt(
    deliveryId: string
  ): Promise<HostedDeliveryResult> {
    const delivery = await getDelivery(options.storage, deliveryId);
    if (!delivery) throw new Error(`Unknown delivery "${deliveryId}"`);
    if (
      delivery.response ||
      (delivery.result &&
        delivery.status !== "pending" &&
        delivery.status !== "retry-wait")
    ) {
      return hostedResult(delivery);
    }

    if (delivery.interactionId) {
      const settlement = await getSettlement(
        options.storage,
        delivery.interactionId
      );
      if (settlement) {
        const settled = {
          ...delivery,
          response: settlement,
          updatedAt: Date.now()
        };
        await putDelivery(options.storage, settled);
        return hostedResult(settled);
      }
    }

    const channel = options.channels[delivery.channelId];
    if (!channel) {
      const result: DeliveryResult = {
        status: "failed",
        retryable: false,
        error: {
          code: "CHANNEL_NOT_CONFIGURED",
          message: `Channel "${delivery.channelId}" is not configured`
        }
      };
      const failed = await recordResult(delivery, result);
      return hostedResult(failed);
    }

    const attemptNumber = delivery.attempt + 1;
    const attempting: StoredDelivery = {
      ...delivery,
      status: "attempting",
      attempt: attemptNumber,
      nextAttemptAt: undefined,
      updatedAt: Date.now()
    };
    await putDelivery(options.storage, attempting);

    let result: DeliveryResult;
    try {
      const available = await channel.isAvailable?.();
      if (available === false) {
        result = unavailable(delivery.channelId);
      } else if (delivery.kind === "approval") {
        if (
          !channel.requestApproval ||
          !delivery.interactionId ||
          !delivery.request
        ) {
          result = {
            status: "failed",
            retryable: false,
            error: {
              code: "APPROVAL_NOT_SUPPORTED",
              message: `Channel "${delivery.channelId}" does not support approval requests`
            }
          };
        } else {
          result = await channel.requestApproval({
            interactionId: delivery.interactionId,
            request: delivery.request,
            delivery: { deliveryId, attempt: attemptNumber },
            ...(options.approvalLinksAvailable && {
              getApprovalLinks: () => options.getApprovalLinks(deliveryId)
            })
          });
        }
      } else if (delivery.message) {
        result = await channel.deliver(delivery.message, {
          deliveryId,
          attempt: attemptNumber
        });
      } else {
        result = uncertain("The durable delivery payload is missing");
      }
    } catch (error) {
      result = uncertain(
        error instanceof Error ? error.message : "Channel delivery threw"
      );
    }

    const recorded = await recordResult(attempting, result);
    return hostedResult(recorded);
  }

  async function recordResult(
    delivery: StoredDelivery,
    result: DeliveryResult
  ): Promise<StoredDelivery> {
    const now = Date.now();
    let recorded: StoredDelivery = {
      ...delivery,
      status: result.status,
      result,
      ...(result.status === "delivered" && result.reference
        ? { providerReference: result.reference }
        : {}),
      updatedAt: now
    };

    if (
      result.status === "failed" &&
      result.retryable &&
      delivery.attempt < options.maxAttempts
    ) {
      const nextAttemptAt =
        now + options.retryBaseDelayMs * 2 ** Math.max(0, delivery.attempt - 1);
      recorded = { ...recorded, status: "retry-wait", nextAttemptAt };
    }

    if (
      recorded.status === "retry-wait" &&
      recorded.nextAttemptAt !== undefined
    ) {
      await persistRetry(recorded);
    } else {
      await putDelivery(options.storage, recorded);
    }
    if (recorded.providerReference && recorded.interactionId) {
      await options.storage.put(
        referenceKey(recorded.channelId, recorded.providerReference),
        {
          kind: "approval",
          interactionId: recorded.interactionId
        } satisfies StoredReference
      );
    }
    return recorded;
  }

  async function persistRetry(delivery: StoredDelivery): Promise<void> {
    const nextAttemptAt = delivery.nextAttemptAt;
    if (nextAttemptAt === undefined) {
      throw new Error(`Retry delivery "${delivery.id}" has no scheduled time`);
    }

    if (options.scheduler.transaction) {
      await options.scheduler.transaction(async (transaction) => {
        await putDeliveryInTransaction(transaction, delivery);
        await transaction.schedule(delivery.id, nextAttemptAt);
      });
      return;
    }

    // Non-transactional adapters must schedule against their own durable
    // mechanism. Persist first so an early callback is harmless; init()
    // reconciles retry-wait records after a scheduling failure or restart.
    await putDelivery(options.storage, delivery);
    await options.scheduler.schedule(delivery.id, nextAttemptAt);
  }

  async function putDeliveryInTransaction(
    transaction: DurableObjectAlarmSourceTransaction,
    delivery: StoredDelivery
  ): Promise<void> {
    await transaction.put(deliveryKey(delivery.id), delivery);
  }

  function assertSameDelivery(
    delivery: StoredDelivery,
    channelId: string,
    message: ChannelMessage
  ): void {
    if (
      delivery.kind !== "message" ||
      delivery.channelId !== channelId ||
      JSON.stringify(delivery.message) !== JSON.stringify(message)
    ) {
      throw new Error(`Delivery "${delivery.id}" was already used differently`);
    }
  }

  function assertSameApproval(
    delivery: StoredDelivery,
    channelId: string,
    interactionId: string,
    request: ChannelApprovalRequest
  ): void {
    if (
      delivery.kind !== "approval" ||
      delivery.channelId !== channelId ||
      delivery.interactionId !== interactionId ||
      JSON.stringify(delivery.request) !== JSON.stringify(request)
    ) {
      throw new Error(
        `Interaction "${interactionId}" was already requested differently`
      );
    }
  }

  return {
    deliver,
    getHostedDelivery,
    handleDueDeliveries,
    initialize,
    requestApproval,
    retryDelivery,
    setApprovalRequestsChannel,
    setDeliveryChannel,
    settleApproval
  };
}

function hostedResult(delivery: StoredDelivery): HostedDeliveryResult {
  return {
    deliveryId: delivery.id,
    channelId: delivery.channelId,
    result:
      delivery.result ??
      uncertain(`Delivery "${delivery.id}" has not completed an attempt`)
  };
}

function uncertain(message: string): DeliveryResult {
  return {
    status: "uncertain",
    error: { code: "CHANNEL_DELIVERY_UNCERTAIN", message }
  };
}

function unavailable(channelId: string): DeliveryResult {
  return {
    status: "failed",
    retryable: true,
    error: {
      code: "CHANNEL_UNAVAILABLE",
      message: `Channel "${channelId}" is unavailable`
    }
  };
}
