import {
  defineMachine,
  type MachineDefinition,
  type MachineEffectRecovery,
  type MachineJson
} from "agents/state-machine";
import type { PiOperationRequest, PiOperationResult } from "./types";

/**
 * A request as it is stored in a durable checkpoint.
 *
 * {@link PiOperationRequest} uses `readonly` arrays, which do not satisfy
 * `MachineJson`'s mutable index signature. The machine therefore carries the
 * request in its serialized form and {@link toOperationRequest} narrows it
 * back at the pi boundary. The value is the same JSON either way.
 */
export type PiRequestJson = { readonly [key: string]: MachineJson };

/** Widen a request for storage in a checkpoint or effect input. */
export function toRequestJson(request: PiOperationRequest): PiRequestJson {
  return request as unknown as PiRequestJson;
}

/** Narrow a stored request back to pi's own request union. */
export function toOperationRequest(request: PiRequestJson): PiOperationRequest {
  return request as unknown as PiOperationRequest;
}

/** Input accepted when one pi operation run is started. */
export type PiRunInput = {
  readonly lane: string;
  readonly operationId: string;
  readonly request: PiRequestJson;
  readonly streamId: string;
};

/** The durable effect handle the machine stores in its checkpoint. */
export type PiEffectRef = {
  readonly id: string;
  readonly kind: string;
  readonly recovery: MachineEffectRecovery;
};

/**
 * One pi operation expressed as a durable checkpoint.
 *
 * Pi owns the transcript, tool intents and results, retries, and recovery;
 * the machine owns only admission, the wrapped drive passes, and settlement.
 * Each pass is its own durable effect, because a settled effect is immutable
 * and one operation usually needs several bounded passes.
 */
export type PiRunState =
  | {
      phase: "admit";
      lane: string;
      operationId: string;
      request: PiRequestJson;
      streamId: string;
    }
  | {
      phase: "drive";
      lane: string;
      operationId: string;
      streamId: string;
      effect: PiEffectRef;
      pass: number;
    }
  | {
      phase: "waiting";
      lane: string;
      operationId: string;
      streamId: string;
      pass: number;
      /** Earliest time pi's own policy allows another drive pass. */
      notBefore: number;
    };

/** Events accepted by one operation run. */
export type PiRunEvent =
  | { type: "pi:drive-ready"; key: string }
  | { type: "pi:steered"; key: string };

/** Terminal outcome of one operation run, projected from pi's own record. */
export type PiRunResult = {
  readonly operationId: string;
  readonly status: PiOperationResult["status"];
  readonly error?: { readonly code: string; readonly message: string };
};

/** The kind name registered for the wrapped pi drive runtime. */
export const PI_DRIVE_EFFECT = "pi-drive";

/** The machine definition name registered with the StateMachine capability. */
export const PI_RUN_DEFINITION = "pi-operation";

/** Longest a parked run sleeps before it re-checks pi's own state. */
const MAX_PARK_MS = 30_000;

/** How soon a still-running external pass is re-checked. */
const RUNNING_POLL_MS = 250;

/** Bound on passes per operation, so a wedged lane cannot spin forever. */
export const MAX_DRIVE_PASSES = 4_000;

/**
 * Input handed to the wrapped pi runtime for one drive pass.
 *
 * The request travels only with the first pass. Once pi has admitted the
 * operation it owns the request, and later passes re-attach to it by id.
 */
export type PiDriveInput = {
  readonly lane: string;
  readonly operationId: string;
  readonly request: PiRequestJson | null;
  readonly streamId: string;
  readonly pass: number;
};

/**
 * What one wrapped drive pass reports back to the machine.
 *
 * `settled` carries pi's immutable terminal record. `waiting` means pi asked
 * to be re-driven later — a provider retry backoff or a deferred poll — and
 * is not an error.
 */
export type PiDriveOutput =
  | { readonly kind: "settled"; readonly result: PiRunResult }
  | { readonly kind: "waiting"; readonly notBefore: number };

function parkUntil(notBefore: number): number {
  const now = Date.now();
  return Math.min(Math.max(notBefore, now), now + MAX_PARK_MS);
}

/** The effect-planning slice of a machine context, narrowed for one pass. */
type PassPlanner = {
  readonly effects: {
    plan: (
      kind: string,
      input: PiDriveInput,
      options: { recovery: MachineEffectRecovery; externalId: string }
    ) => PiEffectRef;
  };
};

/**
 * Plan the effect for one drive pass.
 *
 * Every pass is keyed by `operationId:pass` so a crash mid-pass reconciles
 * against pi's own record for that pass instead of blindly repeating a model
 * request. Pi itself deduplicates admission by operation id.
 */
function planPass(
  context: PassPlanner,
  state: {
    readonly lane: string;
    readonly operationId: string;
    readonly streamId: string;
  },
  pass: number,
  request: PiRequestJson | null
): PiEffectRef {
  return context.effects.plan(
    PI_DRIVE_EFFECT,
    {
      lane: state.lane,
      operationId: state.operationId,
      request,
      streamId: state.streamId,
      pass
    },
    { recovery: "reconcile", externalId: `${state.operationId}:${pass}` }
  );
}

/**
 * The outer machine for one pi operation.
 *
 * Pi already is a durable state machine, so this definition deliberately does
 * not replay pi's model or tool effects. It wraps each bounded drive pass as
 * a `reconcile` effect: after a crash the machine asks pi what happened
 * instead of repeating the request.
 */
export const piRunMachine: MachineDefinition<
  PiRunState,
  PiRunResult,
  PiRunInput,
  PiRunEvent
> = defineMachine<PiRunState, PiRunResult, PiRunInput, PiRunEvent>({
  version: 1,
  initial: (input) => ({
    phase: "admit",
    lane: input.lane,
    operationId: input.operationId,
    request: input.request,
    streamId: input.streamId
  }),
  phases: {
    /**
     * Commit the durable intent to drive this operation before pi is
     * touched, so a crash before the first pass still leaves evidence.
     */
    admit: (state, context) => {
      const effect = planPass(context, state, 0, state.request);
      return context.transition({
        phase: "drive",
        lane: state.lane,
        operationId: state.operationId,
        streamId: state.streamId,
        effect,
        pass: 0
      });
    },

    /** Run one bounded pi drive pass and commit whatever it settled. */
    drive: async (state, context) => {
      const outcome = await context.effects.execute<PiDriveOutput>(
        state.effect
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
        // Pi asked to be re-driven later; park without holding a JavaScript
        // invocation resident.
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

      if (outcome.status === "failed") {
        return context.complete({
          operationId: state.operationId,
          status: "failed",
          error: { code: "drive_failed", message: outcome.error.message }
        });
      }

      if (outcome.status === "interrupted") {
        // Pi kept no record of this pass, so nothing durable is in flight.
        return context.complete({
          operationId: state.operationId,
          status: "failed",
          error: {
            code: "interrupted",
            message: "The pi operation was lost before it settled"
          }
        });
      }

      // Still running externally. Stay in `drive` holding the same effect so
      // the next wake reconciles that execution rather than starting a new
      // one, exactly as the SDK's wrapped-runtime pattern does.
      return context.wait(state, {
        type: "pi:drive-ready",
        key: state.operationId,
        timeoutAt: Date.now() + RUNNING_POLL_MS
      });
    },

    /**
     * Parked between passes. Any wake — the deadline, a steer, or an
     * explicit ready event — plans and enters the next bounded pass.
     */
    waiting: (state, context) => {
      context.events.take({ type: "pi:drive-ready", key: state.operationId });
      context.events.take({ type: "pi:steered", key: state.operationId });
      const pass = state.pass + 1;
      const effect = planPass(context, state, pass, null);
      return context.transition({
        phase: "drive",
        lane: state.lane,
        operationId: state.operationId,
        streamId: state.streamId,
        effect,
        pass
      });
    }
  }

  // Cancellation deliberately declares no `onCancel` handler.
  //
  // Pi is already told to abort through the effect runtime's `cancel`, and it
  // records its own terminal disposition. Handling cancellation here would
  // settle the run as `completed` carrying an "aborted" payload, which
  // misreports a cancelled run to `AgentHarness.inspect()`. Letting
  // StateMachine settle it natively yields `status: "cancelled"`, so the
  // outer control state and pi's record agree.
});
