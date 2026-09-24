import type {
  MachineEffectInvocation,
  MachineEffectRuntime
} from "agents/state-machine";
import type {
  OpenCodeDriveInput,
  OpenCodeDriveOutput,
  OpenCodeRunResult
} from "./machine";

/** One bounded pass over OpenCode's own durable turn loop. */
export type OpenCodeDrivePass = (
  input: OpenCodeDriveInput,
  signal: AbortSignal
) => Promise<OpenCodeDriveOutput>;

/** What OpenCode's durable record says about one turn. */
export type OpenCodeTurnLookup =
  | { readonly status: "running" }
  | { readonly status: "settled"; readonly result: OpenCodeRunResult }
  | { readonly status: "not-found" };

/** The OpenCode-side surface the effect runtime drives. */
export interface OpenCodeDriveHost {
  /** Deliver the message when needed, then run one bounded pass. */
  drive: OpenCodeDrivePass;
  /** Read OpenCode's own record for one turn on a known session. */
  lookup(sessionId: string, operationId: string): Promise<OpenCodeTurnLookup>;
  /** Durably ask OpenCode to stop one turn on a known session. */
  requestAbort(sessionId: string, operationId: string): Promise<void>;
}

/**
 * Adapt OpenCode's durable session loop to the machine's `reconcile` effect
 * protocol.
 *
 * OpenCode is the authority for what a pass did. The machine never re-sends a
 * prompt from its own checkpoint: on recovery it asks OpenCode, through
 * {@link OpenCodeDriveHost.lookup}, whether the turn settled while the object
 * was gone. This is the same contract the pi harness uses, and it is what
 * makes the two harnesses interchangeable behind one SDK shape.
 *
 * OpenCode's `workerd` profile already replays a suspended session on boot
 * via its write-ahead execution claim, so `lookup` usually finds either a
 * completed assistant message or a live session — `not-found` is the narrow
 * case where the message never reached the inbox at all.
 */
export function createOpenCodeDriveRuntime(
  host: OpenCodeDriveHost
): MachineEffectRuntime<OpenCodeDriveInput, OpenCodeDriveOutput> {
  return {
    execute: async (
      input: OpenCodeDriveInput,
      invocation: MachineEffectInvocation
    ): Promise<OpenCodeDriveOutput> => host.drive(input, invocation.signal),

    // Recovery reads the session and operation from the effect's own durable
    // input. Deriving them from in-memory state would be wrong: this runs
    // after an eviction, exactly when process-local state is gone.
    reconcile: async (_externalId, invocation) => {
      const { sessionId, operationId } = invocation.input;
      const looked = await host.lookup(sessionId, operationId);
      if (looked.status === "running") return { status: "running" };
      if (looked.status === "not-found") return { status: "not-found" };
      return {
        status: "completed",
        output: { kind: "settled", result: looked.result }
      };
    },

    cancel: async (_externalId, invocation) => {
      await host.requestAbort(
        invocation.input.sessionId,
        invocation.input.operationId
      );
    }
  };
}
