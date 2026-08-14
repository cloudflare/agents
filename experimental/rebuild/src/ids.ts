/**
 * Id minting and brand casting. Brands are compile-time only; these helpers
 * are the one sanctioned place a raw string becomes a branded id.
 */

import type {
  BlobId,
  BranchId,
  ClaimKey,
  ConsumerName,
  CorrelationId,
  EntryId,
  ReconcilerName,
  StepId,
  TurnId
} from "./contract.js";

declare const globalThis: { crypto: { randomUUID(): string } };

export function uuid(): string {
  return globalThis.crypto.randomUUID();
}

export const asEntryId = (s: string): EntryId => s as EntryId;
export const asBranchId = (s: string): BranchId => s as BranchId;
export const asTurnId = (s: string): TurnId => s as TurnId;
export const asStepId = (s: string): StepId => s as StepId;
export const asClaimKey = (s: string): ClaimKey => s as ClaimKey;
export const asCorrelationId = (s: string): CorrelationId => s as CorrelationId;
export const asConsumerName = (s: string): ConsumerName => s as ConsumerName;
export const asReconcilerName = (s: string): ReconcilerName =>
  s as ReconcilerName;
export const asBlobId = (s: string): BlobId => s as BlobId;

export const ROOT_BRANCH = asBranchId("main");

/** FNV-1a — stable sync digest for idempotency comparisons (not security). */
export function digest(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
