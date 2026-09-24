import { defineMachine, type MachineDefinition } from "agents/state-machine";
import type { PiOperationRequest, PiOperationResult } from "./types";

/** Input accepted when one pi operation run starts. */
export type PiRunInput = {
  readonly lane: string;
  readonly operationId: string;
  readonly request: PiOperationRequest;
  readonly streamId: string;
};

/**
 * The current pass input is checkpointed, but its effect handle is not.
 * `effects.run()` recovers that handle from the phase's stable builder slot.
 */
export type PiRunState =
  | {
      phase: "drive";
      lane: string;
      operationId: string;
      request: PiOperationRequest | null;
      streamId: string;
      pass: number;
    }
  | {
      phase: "waiting";
      lane: string;
      operationId: string;
      streamId: string;
      pass: number;
      notBefore: number;
    };

/** Durable wakes accepted by an operation run. */
export type PiRunEvent =
  | { type: "pi:drive-ready"; key: string }
  | { type: "pi:steered"; key: string };

/** Terminal disposition projected from pi's own durable record. */
export type PiRunResult = {
  readonly operationId: string;
  readonly status: PiOperationResult["status"];
  readonly error?: { readonly code: string; readonly message: string };
};

/** Effect and definition names owned by the pi integration. */
export const PI_DRIVE_EFFECT = "pi-drive";
export const PI_RUN_DEFINITION = "pi-operation";

const MAX_PARK_MS = 30_000;
const RUNNING_POLL_MS = 250;
/**
 * No `timeoutMs` on the drive effect, deliberately.
 *
 * A pass is turn-sized: `driveOperation` returns only on `settled` or
 * `waiting`, so a healthy turn can outlive any timeout we would pick. An
 * effect timeout is not a detach — `withTimeout` calls `controller.abort()`,
 * and `#drivePass` turns that abort into `requestAbort()`, which sets pi's
 * *durable* `cancel_requested` marker. A slow turn would be cancelled rather
 * than resumed, and the retry policy would then re-drive an operation pi has
 * already condemned.
 *
 * A timeout is also unnecessary. `driveOperation` runs as a floating promise
 * owned by the lane's `activeDrive`, and the caller only observes it through
 * `awaitWithContext`, which rejects the observer without touching the work.
 * An invocation that dies mid-pass leaves the Drive intact, and the next pass
 * re-attaches by operation id (`{ kind: "observe", installed: false }`). So
 * losing the observer is already the recovery path, and `recovery:
 * "reconcile"` covers the case where the whole isolate went away.
 */
export const PI_DRIVE_RETRY_LIMIT = 3;
export const PI_DRIVE_RETRY_DELAY_MS = 250;
export const MAX_DRIVE_PASSES = 4_000;

/** Durable input for one bounded pass through pi's drive loop. */
export type PiDriveInput = {
  readonly lane: string;
  readonly operationId: string;
  readonly request: PiOperationRequest | null;
  readonly streamId: string;
  readonly pass: number;
};

/** One pass either settles pi or asks the machine to drive it later. */
export type PiDriveOutput =
  | { readonly kind: "settled"; readonly result: PiRunResult }
  | { readonly kind: "waiting"; readonly notBefore: number };

function parkUntil(notBefore: number): number {
  const now = Date.now();
  return Math.min(Math.max(notBefore, now), now + MAX_PARK_MS);
}

/**
 * Wrap pi without replaying its model or tool work. Uncertain passes reconcile
 * against pi's operation record; attachment failures retry the same effect.
 */
export const piRunMachine: MachineDefinition<
  PiRunState,
  PiRunResult,
  PiRunInput,
  PiRunEvent
> = defineMachine<PiRunState, PiRunResult, PiRunInput, PiRunEvent>({
  version: 2,
  initial: (input) => ({
    phase: "drive",
    lane: input.lane,
    operationId: input.operationId,
    request: input.request,
    streamId: input.streamId,
    pass: 0
  }),
  phases: {
    drive: async (state, context) => {
      // Consume an early wake before parking again on the same drive slot.
      context.events.take({
        type: "pi:drive-ready",
        key: state.operationId
      });
      context.events.take({ type: "pi:steered", key: state.operationId });
      const outcome = await context.effects.run<PiDriveInput, PiDriveOutput>(
        PI_DRIVE_EFFECT,
        {
          lane: state.lane,
          operationId: state.operationId,
          request: state.request,
          streamId: state.streamId,
          pass: state.pass
        },
        {
          recovery: "reconcile",
          externalId: `${state.operationId}:${state.pass}`,
          retries: {
            limit: PI_DRIVE_RETRY_LIMIT,
            delay: PI_DRIVE_RETRY_DELAY_MS,
            backoff: "exponential"
          }
        }
      );

      if (outcome.status === "completed") {
        const output = outcome.output;
        if (output.kind === "settled") {
          return context.complete(output.result);
        }
        if (state.pass + 1 >= MAX_DRIVE_PASSES) {
          return context.complete({
            operationId: state.operationId,
            status: "failed",
            error: {
              code: "pass_budget_exhausted",
              message: `The operation exceeded ${MAX_DRIVE_PASSES} drive passes`
            }
          });
        }
        return context.wait(
          {
            phase: "waiting",
            lane: state.lane,
            operationId: state.operationId,
            streamId: state.streamId,
            pass: state.pass,
            notBefore: output.notBefore
          },
          {
            type: "pi:drive-ready",
            key: state.operationId,
            timeoutAt: parkUntil(output.notBefore)
          }
        );
      }

      if (outcome.status === "retrying") {
        return context.wait(state, {
          type: "pi:drive-ready",
          key: state.operationId,
          timeoutAt: outcome.retryAt
        });
      }

      if (outcome.status === "failed") {
        return context.complete({
          operationId: state.operationId,
          status: "failed",
          error: { code: "drive_failed", message: outcome.error.message }
        });
      }

      if (outcome.status === "interrupted") {
        return context.complete({
          operationId: state.operationId,
          status: "failed",
          error: {
            code: "interrupted",
            message: "The pi operation was lost before it settled"
          }
        });
      }

      return context.wait(state, {
        type: "pi:drive-ready",
        key: state.operationId,
        timeoutAt: Date.now() + RUNNING_POLL_MS
      });
    },

    waiting: (state, context) => {
      context.events.take({ type: "pi:drive-ready", key: state.operationId });
      context.events.take({ type: "pi:steered", key: state.operationId });
      return context.transition({
        phase: "drive",
        lane: state.lane,
        operationId: state.operationId,
        request: null,
        streamId: state.streamId,
        pass: state.pass + 1
      });
    }
  }

  // Pi records its own abort before StateMachine cancellation reaches the
  // effect runtime. Native machine cancellation keeps both status views aligned.
});
