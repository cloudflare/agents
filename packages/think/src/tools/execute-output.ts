import { truncateResult } from "@cloudflare/codemode";

const PENDING_ARGS_MAX_CHARS = 2_000;

/** Bound paused execution arguments before storing them in the transcript. */
export function truncatePausedExecutionOutput(output: unknown): unknown {
  if (typeof output !== "object" || output === null) return output;
  const candidate = output as { status?: unknown; pending?: unknown };
  if (candidate.status !== "paused" || !Array.isArray(candidate.pending)) {
    return output;
  }
  return {
    ...candidate,
    pending: candidate.pending.map((action) => {
      if (typeof action !== "object" || action === null) return action;
      const pendingAction = action as { args?: unknown };
      if (!("args" in pendingAction)) return action;
      return {
        ...pendingAction,
        args: truncateResult(pendingAction.args, {
          maxChars: PENDING_ARGS_MAX_CHARS
        })
      };
    })
  };
}
