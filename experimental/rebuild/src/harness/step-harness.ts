/**
 * The default Harness (ADR 0002): drives a turn to quiescence one
 * AgentLoop.step() at a time, committing a turn/marker after each step so a
 * cold reader — including the next wake of this very function — can
 * reconstruct execution state from the log alone.
 *
 * drive() is called fresh per wake and holds no state between wakes. Its
 * whole rehydration is reading markers off deps.view; the at-least-once
 * discipline lives in the AgentLoop (which consults the view before
 * generating).
 */

import type {
  AgentLoop,
  ContextAssembler,
  Harness,
  LanguageModel,
  LoopPolicy,
  NewEntry,
  StepDeps,
  TurnDeps,
  TurnFailureNotice,
  TurnMarkerPayload
} from "../contract";
import { asStepId, uuid } from "../ids";

export interface StepHarnessConfig {
  readonly loop: AgentLoop;
  readonly model: LanguageModel;
  readonly context: ContextAssembler;
  readonly policy: LoopPolicy;
  readonly failureNotice?: TurnFailureNotice;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as unknown as { unref?: () => void }).unref?.();
  });

export function stepHarness(config: StepHarnessConfig): Harness {
  return {
    async drive(deps: TurnDeps): Promise<void> {
      const markers = await deps.view.query({
        kinds: ["turn/marker"],
        turn: deps.turn.turnId,
        limit: config.policy.maxSteps * 2 + 8
      });
      const latest = markers[0]?.payload as TurnMarkerPayload | undefined;
      if (latest !== undefined && (latest.marker === "completed" || latest.marker === "failed")) {
        return; // idempotent re-drive of a finished turn
      }
      let stepsCommitted = markers.filter(
        (m) => (m.payload as TurnMarkerPayload).marker === "step-committed"
      ).length;

      const stepDeps: StepDeps = {
        ...deps,
        model: config.model,
        context: config.context,
        loop: config.loop
      };

      let attempt = 1;
      while (stepsCommitted < config.policy.maxSteps) {
        if (deps.signal.aborted) {
          await commitMarker(deps, "failed", { reason: "aborted" });
          return;
        }
        let outcome;
        try {
          outcome = await config.loop.step(stepDeps);
        } catch (error) {
          outcome = {
            outcome: "failed" as const,
            message: error instanceof Error ? error.message : String(error),
            retryable: false
          };
        }

        if (outcome.outcome === "continue") {
          stepsCommitted += 1;
          attempt = 1;
          await commitMarker(deps, "step-committed");
          continue;
        }
        if (outcome.outcome === "completed") {
          await commitMarker(deps, "completed");
          return;
        }
        if (outcome.outcome === "parked") {
          await commitMarker(deps, "parked", { reason: outcome.reason });
          return;
        }
        // failed
        if (outcome.retryable && attempt < config.policy.retry.maxAttempts) {
          const { initialMs, factor, maxMs } = config.policy.retry.backoff;
          await sleep(Math.min(initialMs * factor ** (attempt - 1), maxMs));
          attempt += 1;
          continue;
        }
        await failTerminally(
          deps,
          config,
          outcome.retryable ? "exhausted" : "fatal",
          outcome.message
        );
        return;
      }
      await failTerminally(deps, config, "exhausted", `step budget spent (${config.policy.maxSteps})`);
    }
  };
}

async function failTerminally(
  deps: TurnDeps,
  config: StepHarnessConfig,
  reason: "exhausted" | "aborted" | "fatal",
  message: string
): Promise<void> {
  const notice: readonly NewEntry[] =
    config.failureNotice?.build({ turn: deps.turn, reason, message }) ?? [];
  await deps.commit([
    ...notice,
    markerEntry(deps, "failed", { reason, message })
  ]);
}

async function commitMarker(
  deps: TurnDeps,
  marker: TurnMarkerPayload["marker"],
  detail?: Record<string, string>
): Promise<void> {
  await deps.commit([markerEntry(deps, marker, detail)]);
}

function markerEntry(
  deps: TurnDeps,
  marker: TurnMarkerPayload["marker"],
  detail?: Record<string, string>
): NewEntry {
  const payload: TurnMarkerPayload = {
    kind: "turn/marker",
    v: 1,
    marker,
    turnId: deps.turn.turnId,
    step: asStepId(uuid()),
    attempt: deps.turn.attempt,
    ...(detail !== undefined ? { detail } : {})
  };
  return {
    origin: { module: "harness" },
    turn: deps.turn.turnId,
    payload
  } as NewEntry;
}
