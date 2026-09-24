import {
  defineMachine,
  type MachineContext,
  type MachineDefinition,
  type MachineEffectRef
} from "agents/state-machine";

/** How one OpenCode turn was requested. */
export type OpenCodeRequest =
  | { readonly kind: "prompt"; readonly text: string; readonly agent?: string }
  | { readonly kind: "command"; readonly command: string; readonly args?: string }
  | { readonly kind: "skill"; readonly skill: string; readonly text?: string }
  | { readonly kind: "compact" };

/** Input accepted when one OpenCode turn run is started. */
export type OpenCodeRunInput = {
  readonly sessionId: string;
  readonly operationId: string;
  readonly request: OpenCodeRequest;
  readonly streamId: string;
};

/**
 * One OpenCode turn expressed as a durable checkpoint.
 *
 * OpenCode owns the transcript, the inbox, tool calls and their results,
 * permissions, and its own boot-time replay of a suspended session. The
 * machine owns only admission (getting the message into OpenCode's inbox),
 * the bounded waits that follow, and settlement — exactly the wrapped-runtime
 * shape the pi harness uses, for the same reason: OpenCode is already a
 * durable state machine and must stay the single authority for its effects.
 */
export type OpenCodeRunState =
  | {
      phase: "admit";
      sessionId: string;
      operationId: string;
      request: OpenCodeRequest;
      streamId: string;
    }
  | {
      phase: "drive";
      sessionId: string;
      operationId: string;
      streamId: string;
      effect: MachineEffectRef<OpenCodeDriveOutput>;
      pass: number;
    }
  | {
      phase: "waiting";
      sessionId: string;
      operationId: string;
      streamId: string;
      pass: number;
      /** Earliest time another drive pass is worth attempting. */
      notBefore: number;
    };

/** Events accepted by one turn run. */
export type OpenCodeRunEvent =
  | { type: "oc:drive-ready"; key: string }
  | { type: "oc:steered"; key: string }
  | { type: "oc:permission-replied"; key: string };

/** Terminal outcome of one turn, projected from OpenCode's own record. */
export type OpenCodeRunResult = {
  readonly operationId: string;
  readonly status: "completed" | "aborted" | "failed" | "declined";
  readonly messageId?: string;
  readonly error?: { readonly code: string; readonly message: string };
};

export const OPENCODE_DRIVE_EFFECT = "opencode-drive";
export const OPENCODE_RUN_DEFINITION = "opencode-turn";

/** Longest a parked run sleeps before it re-checks OpenCode's own state. */
const MAX_PARK_MS = 30_000;
/** How soon a still-running external pass is re-checked. */
const RUNNING_POLL_MS = 250;
/** Bound on passes per turn so a wedged session cannot spin forever. */
export const MAX_DRIVE_PASSES = 4_000;

/**
 * Input handed to the wrapped OpenCode runtime for one pass.
 *
 * The request travels only with the first pass. Once OpenCode has the message
 * in its inbox it owns the turn, and later passes re-attach by session id.
 */
export type OpenCodeDriveInput = {
  readonly sessionId: string;
  readonly operationId: string;
  readonly request: OpenCodeRequest | null;
  readonly streamId: string;
  readonly pass: number;
};

/**
 * What one wrapped pass reports back.
 *
 * `waiting` is not an error: it means OpenCode is still working but the pass
 * hit its bound (a permission prompt awaiting a reply, a long tool call, or
 * simply the invocation budget), so the run should park on a durable deadline
 * rather than hold a JavaScript invocation open.
 */
export type OpenCodeDriveOutput =
  | { readonly kind: "settled"; readonly result: OpenCodeRunResult }
  | {
      readonly kind: "waiting";
      readonly notBefore: number;
      readonly reason: "permission" | "busy" | "budget";
    };

function parkUntil(notBefore: number): number {
  const now = Date.now();
  return Math.min(Math.max(notBefore, now), now + MAX_PARK_MS);
}

/**
 * Plan the effect for one pass.
 *
 * Every pass is keyed by `operationId:pass` so a crash mid-pass reconciles
 * against OpenCode's own record for that pass instead of blindly re-sending
 * the prompt. OpenCode deduplicates the message itself by message id, which
 * is why the harness derives that id from `operationId`.
 */
function planPass(
  context: MachineContext<OpenCodeRunState, OpenCodeRunResult, OpenCodeRunEvent>,
  state: {
    readonly sessionId: string;
    readonly operationId: string;
    readonly streamId: string;
  },
  pass: number,
  request: OpenCodeRequest | null
): MachineEffectRef<OpenCodeDriveOutput> {
  return context.effects.plan(
    OPENCODE_DRIVE_EFFECT,
    {
      sessionId: state.sessionId,
      operationId: state.operationId,
      request,
      streamId: state.streamId,
      pass
    },
    { recovery: "reconcile", externalId: `${state.operationId}:${pass}` }
  );
}

/**
 * The outer machine for one OpenCode turn.
 *
 * It deliberately does not model OpenCode's model/tool phases. Each bounded
 * pass is a `reconcile` effect: after an eviction the machine asks OpenCode
 * what happened (`session.active`, `message.list`) instead of repeating work.
 */
export const openCodeRunMachine: MachineDefinition<
  OpenCodeRunState,
  OpenCodeRunResult,
  OpenCodeRunInput,
  OpenCodeRunEvent
> = defineMachine<
  OpenCodeRunState,
  OpenCodeRunResult,
  OpenCodeRunInput,
  OpenCodeRunEvent
>({
  version: 1,
  initial: (input) => ({
    phase: "admit",
    sessionId: input.sessionId,
    operationId: input.operationId,
    request: input.request,
    streamId: input.streamId
  }),
  phases: {
    /**
     * Commit the durable intent to drive this turn before OpenCode is
     * touched, so a crash before the first pass still leaves evidence.
     */
    admit: (state, context) => {
      const effect = planPass(context, state, 0, state.request);
      return context.transition({
        phase: "drive",
        sessionId: state.sessionId,
        operationId: state.operationId,
        streamId: state.streamId,
        effect,
        pass: 0
      });
    },

    /** Run one bounded pass and commit whatever it settled. */
    drive: async (state, context) => {
      const outcome = await context.effects.execute(state.effect);

      if (outcome.status === "completed") {
        const output = outcome.output;
        if (output.kind === "settled") return context.complete(output.result);
        if (state.pass + 1 >= MAX_DRIVE_PASSES) {
          return context.complete({
            operationId: state.operationId,
            status: "failed",
            error: {
              code: "pass_budget_exhausted",
              message: `The turn exceeded ${MAX_DRIVE_PASSES} drive passes`
            }
          });
        }
        // A permission prompt parks indefinitely until the reply arrives; the
        // timeout is only a floor so a lost notify still makes progress.
        return context.wait(
          {
            phase: "waiting",
            sessionId: state.sessionId,
            operationId: state.operationId,
            streamId: state.streamId,
            pass: state.pass,
            notBefore: output.notBefore
          },
          {
            type:
              output.reason === "permission"
                ? "oc:permission-replied"
                : "oc:drive-ready",
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
        // OpenCode kept no record of this pass: nothing durable is in flight.
        return context.complete({
          operationId: state.operationId,
          status: "failed",
          error: {
            code: "interrupted",
            message: "The OpenCode turn was lost before it settled"
          }
        });
      }

      // Still running externally. Hold the same effect so the next wake
      // reconciles that execution rather than starting a second one.
      return context.wait(state, {
        type: "oc:drive-ready",
        key: state.operationId,
        timeoutAt: Date.now() + RUNNING_POLL_MS
      });
    },

    /**
     * Parked between passes. Resumes on whichever comes first: the deadline,
     * a steer, or a permission reply.
     */
    waiting: (state, context) => {
      context.events.take({ type: "oc:drive-ready", key: state.operationId });
      context.events.take({ type: "oc:steered", key: state.operationId });
      context.events.take({
        type: "oc:permission-replied",
        key: state.operationId
      });
      const pass = state.pass + 1;
      const effect = planPass(context, state, pass, null);
      return context.transition({
        phase: "drive",
        sessionId: state.sessionId,
        operationId: state.operationId,
        streamId: state.streamId,
        effect,
        pass
      });
    }
  }

  // No `onCancel` handler, deliberately. OpenCode is told to stop through the
  // effect runtime's `cancel` (session.interrupt / session.abort) and records
  // its own disposition; letting StateMachine settle the run natively yields
  // `status: "cancelled"`, so the outer control state and OpenCode agree.
});
