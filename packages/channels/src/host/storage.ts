import type {
  ChannelHostStorage,
  StoredApprovalResponse,
  StoredDelivery
} from "./types";

const STORAGE_PREFIX = "cf_channels:";
export const DELIVERY_PREFIX = `${STORAGE_PREFIX}delivery:`;
const REFERENCE_PREFIX = `${STORAGE_PREFIX}reference:`;
const RECEIPT_PREFIX = `${STORAGE_PREFIX}receipt:`;
const LINK_PREFIX = `${STORAGE_PREFIX}approval-link:`;
const SETTLEMENT_PREFIX = `${STORAGE_PREFIX}settlement:`;
export const APPROVAL_ROUTE_KEY = `${STORAGE_PREFIX}route:approval`;
export const DELIVERY_ROUTE_KEY = `${STORAGE_PREFIX}route:delivery`;

function storageKey(prefix: string, value: string): string {
  return `${prefix}${encodeURIComponent(value)}`;
}

export function approvalDeliveryId(interactionId: string): string {
  return `approval:${interactionId}`;
}

export function deliveryKey(deliveryId: string): string {
  return storageKey(DELIVERY_PREFIX, deliveryId);
}

export function referenceKey(channelId: string, reference: string): string {
  return storageKey(REFERENCE_PREFIX, `${channelId}:${reference}`);
}

export function receiptKey(channelId: string, reference: string): string {
  return storageKey(RECEIPT_PREFIX, `${channelId}:${reference}`);
}

export function approvalLinkKey(token: string): string {
  return storageKey(LINK_PREFIX, token);
}

export function settlementKey(interactionId: string): string {
  return storageKey(SETTLEMENT_PREFIX, interactionId);
}

export function getDelivery(
  storage: ChannelHostStorage,
  id: string
): Promise<StoredDelivery | undefined> {
  return storage.get<StoredDelivery>(deliveryKey(id));
}

export async function putDelivery(
  storage: ChannelHostStorage,
  delivery: StoredDelivery
): Promise<void> {
  await storage.put(deliveryKey(delivery.id), delivery);
}

export function getSettlement(
  storage: ChannelHostStorage,
  interactionId: string
): Promise<StoredApprovalResponse | undefined> {
  return storage.get<StoredApprovalResponse>(settlementKey(interactionId));
}
