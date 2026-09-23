import type {
  MachineEffectInvocation,
  MachineEffectRuntime
} from "agents/state-machine";
import type { PiDriveInput, PiDriveOutput, PiRunResult } from "./machine";

/** One bounded pass over pi's own durable drive loop. */
export type PiDrivePass = (
  input: PiDriveInput,
  signal: AbortSignal
) => Promise<PiDriveOutput>;

/** What pi's durable record says about one operation. */
export type PiOperationLookup =
  | { readonly status: "running" }
  | { readonly status: "settled"; readonly result: PiRunResult }
  | { readonly status: "not-found" };

/** The pi-side surface the effect runtime drives. */
export interface PiDriveHost {
  /** Admit the operation when needed, then run one bounded drive pass. */
  drive: PiDrivePass;
  /** Read pi's own durable record for one operation. */
  lookup(operationId: string): Promise<PiOperationLookup>;
  /** Durably ask pi to stop the operation, whichever lane owns it. */
  requestAbort(operationId: string): Promise<void>;
}

/** Recover the operation id from a `operationId:pass` external id. */
function operationIdOf(externalId: string): string {
  const separator = externalId.lastIndexOf(":");
  return separator === -1 ? externalId : externalId.slice(0, separator);
}

/**
 * Adapt pi's durable lane loop to the machine's `reconcile` effect protocol.
 *
 * Pi is the authority for what a pass did. The machine never repeats a model
 * request from its own checkpoint: on recovery it asks pi, through
 * {@link PiDriveHost.lookup}, whether the operation settled while the object
 * was gone. A settled operation reconciles to `completed`; one pi still
 * considers live reconciles to `running` so the machine parks and re-checks;
 * an operation pi never recorded reconciles to `not-found`, which the
 * machine reports as interrupted rather than silently retrying.
 */
export function createPiDriveRuntime(
  host: PiDriveHost
): MachineEffectRuntime<PiDriveInput, PiDriveOutput> {
  return {
    execute: async (
      input: PiDriveInput,
      invocation: MachineEffectInvocation
    ): Promise<PiDriveOutput> => host.drive(input, invocation.signal),

    reconcile: async (externalId: string) => {
      const operationId = operationIdOf(externalId);
      const looked = await host.lookup(operationId);
      if (looked.status === "running") return { status: "running" };
      if (looked.status === "not-found") return { status: "not-found" };
      return {
        status: "completed",
        output: { kind: "settled", result: looked.result }
      };
    },

    cancel: async (externalId: string) => {
      await host.requestAbort(operationIdOf(externalId));
    }
  };
}
