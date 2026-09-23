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
  /** Read pi's own durable record for one operation on a known lane. */
  lookup(lane: string, operationId: string): Promise<PiOperationLookup>;
  /** Durably ask pi to stop one operation on a known lane. */
  requestAbort(lane: string, operationId: string): Promise<void>;
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

    // Recovery reads the lane and operation from the effect's own durable
    // input. Deriving them from `externalId`, or from an in-memory table,
    // would be wrong here: this runs after an eviction, which is exactly
    // when process-local state is gone.
    reconcile: async (_externalId, invocation) => {
      const { lane, operationId } = invocation.input;
      const looked = await host.lookup(lane, operationId);
      if (looked.status === "running") return { status: "running" };
      if (looked.status === "not-found") return { status: "not-found" };
      return {
        status: "completed",
        output: { kind: "settled", result: looked.result }
      };
    },

    cancel: async (_externalId, invocation) => {
      await host.requestAbort(
        invocation.input.lane,
        invocation.input.operationId
      );
    }
  };
}
