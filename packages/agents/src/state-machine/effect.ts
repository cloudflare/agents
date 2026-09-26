import type { MachineEffectPending } from "./types";

const pendingEffects = new WeakSet<object>();

/** Return a durable external execution that must be reconciled later. */
export function effectPending(externalId: string): MachineEffectPending {
  if (externalId.length === 0) {
    throw new Error("Pending Machine effects require an externalId");
  }
  const pending = Object.freeze({
    status: "running" as const,
    externalId,
    __brand: "MachineEffectPending" as const
  });
  pendingEffects.add(pending);
  return pending;
}

/** @internal Validate a value returned by an effect runtime. */
export function isMachineEffectPending(
  value: unknown
): value is MachineEffectPending {
  return (
    typeof value === "object" && value !== null && pendingEffects.has(value)
  );
}
