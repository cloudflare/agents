import type { Channel } from "../channel";
import type {
  ChannelApprovalResponse,
  ChannelEmailInput,
  ChannelIngressEvent
} from "../ingress";
import {
  approvalDeliveryId,
  getDelivery,
  getSettlement,
  putDelivery,
  receiptKey,
  referenceKey,
  settlementKey
} from "./storage";
import {
  ChannelApprovalConflictError,
  type ChannelHostOptions,
  type ChannelHostStorage,
  type StoredReference
} from "./types";

export type IngressDispatcher = {
  handleEvent(channelId: string, event: ChannelIngressEvent): Promise<void>;
  handleRequest(request: Request): Promise<Response | undefined>;
  handleEmail(email: ChannelEmailInput): Promise<boolean>;
};

export function createIngressDispatcher(options: {
  channels: Record<string, Channel>;
  storage: ChannelHostStorage;
  onApprovalResponse: ChannelHostOptions["onApprovalResponse"];
  onMessage: ChannelHostOptions["onMessage"];
}): IngressDispatcher {
  const emailIngress = Object.fromEntries(
    Object.entries(options.channels).flatMap(([channelId, channel]) =>
      channel.emailIngress ? [[channelId, channel.emailIngress]] : []
    )
  );
  const inFlightReceipts = new Map<string, Promise<void>>();
  const inFlightInteractions = new Map<string, Promise<void>>();

  async function handleRequest(
    request: Request
  ): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    const entry = Object.entries(options.channels)
      .filter(([, channel]) => {
        const ingressPath = channel.ingress?.path;
        return (
          ingressPath !== undefined &&
          (path === ingressPath || path.endsWith(ingressPath))
        );
      })
      .sort(
        ([, left], [, right]) =>
          (right.ingress?.path.length ?? 0) - (left.ingress?.path.length ?? 0)
      )[0];
    if (!entry) return undefined;

    const [channelId, channel] = entry;
    const ingress = channel.ingress;
    if (!ingress) return undefined;

    const result = await ingress.receive(request);
    try {
      for (const event of result.events) {
        await handleEvent(channelId, event);
      }
      return result.response;
    } catch (error) {
      return error instanceof ChannelApprovalConflictError
        ? result.response
        : new Response("Failed to handle Channel event", { status: 500 });
    }
  }

  async function handleEmail(email: ChannelEmailInput): Promise<boolean> {
    const entry = Object.entries(emailIngress).find(([, ingress]) =>
      ingress.accepts ? ingress.accepts(email) : true
    );
    if (!entry) return false;

    const [channelId, ingress] = entry;
    const result = await ingress.receive(email);
    for (const event of result.events) {
      await handleEvent(channelId, event);
    }
    return true;
  }

  async function handleEvent(
    channelId: string,
    event: ChannelIngressEvent
  ): Promise<void> {
    const durableReceiptKey = receiptKey(channelId, event.reference);
    if (await options.storage.get<boolean>(durableReceiptKey)) return;
    const inFlightReceipt = inFlightReceipts.get(durableReceiptKey);
    if (inFlightReceipt) return inFlightReceipt;

    if (event.type === "message") {
      const handlingMessage = (async () => {
        await options.onMessage?.({ channelId, message: event });
        await options.storage.put(durableReceiptKey, true);
      })();
      inFlightReceipts.set(durableReceiptKey, handlingMessage);
      try {
        await handlingMessage;
      } finally {
        if (inFlightReceipts.get(durableReceiptKey) === handlingMessage) {
          inFlightReceipts.delete(durableReceiptKey);
        }
      }
      return;
    }

    const interactionId = await resolveInteractionId(channelId, event);
    if (!interactionId) return;
    const inFlightInteraction = inFlightInteractions.get(interactionId);
    if (inFlightInteraction) return inFlightInteraction;

    const handling = dispatchApprovalResponse(
      channelId,
      interactionId,
      event,
      durableReceiptKey
    );
    inFlightReceipts.set(durableReceiptKey, handling);
    inFlightInteractions.set(interactionId, handling);
    try {
      await handling;
    } finally {
      if (inFlightReceipts.get(durableReceiptKey) === handling) {
        inFlightReceipts.delete(durableReceiptKey);
      }
      if (inFlightInteractions.get(interactionId) === handling) {
        inFlightInteractions.delete(interactionId);
      }
    }
  }

  async function resolveInteractionId(
    channelId: string,
    response: ChannelApprovalResponse
  ): Promise<string | undefined> {
    if (response.interactionId) return response.interactionId;
    if (!response.replyToReference) return undefined;
    const reference = await options.storage.get<StoredReference>(
      referenceKey(channelId, response.replyToReference)
    );
    return reference?.interactionId;
  }

  async function dispatchApprovalResponse(
    channelId: string,
    interactionId: string,
    response: ChannelApprovalResponse,
    durableReceiptKey: string
  ): Promise<void> {
    const deliveryId = approvalDeliveryId(interactionId);
    const delivery = await getDelivery(options.storage, deliveryId);
    if (
      !delivery ||
      delivery.kind !== "approval" ||
      delivery.interactionId !== interactionId
    ) {
      await options.storage.put(durableReceiptKey, true);
      return;
    }
    const settled = await getSettlement(options.storage, interactionId);
    if (settled) {
      await options.storage.put(durableReceiptKey, true);
      return;
    }

    try {
      await options.onApprovalResponse({
        channelId,
        interactionId,
        decision: response.decision,
        reference: response.reference,
        ...(response.sender && { sender: response.sender })
      });
    } catch (error) {
      if (error instanceof ChannelApprovalConflictError) {
        await options.storage.put(durableReceiptKey, true);
      }
      throw error;
    }

    const recordedResponse = (await getSettlement(
      options.storage,
      interactionId
    )) ?? {
      decision: response.decision,
      channelId,
      reference: response.reference,
      receivedAt: Date.now()
    };
    await options.storage.put(settlementKey(interactionId), recordedResponse);
    const latestDelivery = await getDelivery(options.storage, deliveryId);
    if (latestDelivery) {
      await putDelivery(options.storage, {
        ...latestDelivery,
        response: recordedResponse,
        updatedAt: Date.now()
      });
    }
    await options.storage.put(durableReceiptKey, true);
  }

  return { handleEmail, handleEvent, handleRequest };
}
