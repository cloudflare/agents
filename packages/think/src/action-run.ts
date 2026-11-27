/**
 * Running an action through the action ledger: the idempotency key, the
 * durable claim and replay, and the ledger events. Both Thinks call it.
 *
 * @internal Not exported from any entry point.
 */

import { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "agents";
import type { Tasks } from "agents/tasks";
import {
  runEffectOnce,
  stableHash,
  type EffectOutcome,
  type EffectState
} from "./action-ledger";
import { actionContextWithoutReply, actionErrorEnvelope } from "./action-tools";
import type { ActionContext, ActionIdempotencyKey } from "./actions";

/** @internal */
export type ActionLedgerEvent =
  | {
      type: "action:ledger:replayed";
      payload: { action: string; key: string; inputHash: string };
    }
  | {
      type: "action:ledger:pending";
      payload: { action: string; key: string; inputHash: string };
    }
  | {
      type: "action:ledger:conflict";
      payload: { action: string; key: string; inputHash: string };
    }
  | {
      type: "action:ledger:serialize_failed";
      payload: { action: string; key: string };
    }
  | {
      type: "action:ledger:settled";
      payload: { action: string; key: string; inputHash: string };
    }
  | {
      type: "action:ledger:reclaimed";
      payload: {
        action: string;
        key: string;
        inputHash: string;
        ageMs: number;
      };
    }
  | {
      type: "action:ledger:swept";
      payload: { settled: number; pending: number };
    };

/** @internal */
export type LedgeredActionArgs = {
  toolName: string;
  idempotencyKey: ActionIdempotencyKey<unknown> | undefined;
  input: unknown;
  ctx: ActionContext;
  runAction: () => Promise<unknown>;
  /**
   * What to answer for a claim another attempt left that its lease lets
   * be taken over later (an explicit key with a finite lease). Without
   * it, that claim answers `ActionPendingError`.
   */
  onReclaimableInDoubt?: () => unknown;
};

/** What `runLedgeredAction` needs from its agent. @internal */
export type ActionLedgerDeps = {
  tasks: Tasks;
  effects: EffectState;
  pendingRetryLeaseMs: number | false;
  emit(event: ActionLedgerEvent): void;
  /** The turn's reply attachments, which a failed run takes back. */
  attachments: { count(): number; truncate(count: number): void };
};

function actionPendingErrorEnvelope(): {
  error: { name: string; message: string };
} {
  return {
    error: {
      name: "ActionPendingError",
      message:
        "A prior attempt of this action is in an unknown state; not re-executed. Manual reconciliation may be required."
    }
  };
}

function actionKeyConflictEnvelope(
  actionName: string,
  key: string
): {
  error: { name: string; message: string };
} {
  return {
    error: {
      name: "ActionKeyConflict",
      message: `Idempotency key "${key}" for action "${actionName}" was reused with different input. This is a programming error; do not retry.`
    }
  };
}

async function resolveActionLedgerKey(
  actionName: string,
  spec: ActionIdempotencyKey<unknown> | undefined,
  input: unknown,
  ctx: ActionContext
): Promise<string | null> {
  if (spec !== undefined) {
    const key = typeof spec === "function" ? await spec({ input, ctx }) : spec;
    if (key.length === 0) {
      throw new Error(
        `Action "${actionName}" returned an empty idempotency key`
      );
    }
    return `action:${actionName}:${key}`;
  }
  return ctx.toolCallId ? `tool:${ctx.toolCallId}` : null;
}

/**
 * Run an action's `execute` through the action ledger: same-isolate
 * coalescing, durable claim/replay, settle-on-success, release-on-failure.
 * Shared by the inline server-action path and the durable-pause-on-approve
 * path so an action's side effect is replay-safe regardless of how it is
 * dispatched. `runAction` must already apply timeout/abort and
 * `prepareActionOutputForModel`.
 *
 * @internal
 */
export async function runLedgeredAction(
  deps: ActionLedgerDeps,
  args: LedgeredActionArgs
): Promise<unknown> {
  const { toolName, idempotencyKey, input, ctx, runAction } = args;
  const key = await resolveActionLedgerKey(
    toolName,
    idempotencyKey,
    input,
    actionContextWithoutReply(ctx)
  );
  // A failed run takes back the reply attachments it recorded.
  const attachmentCount = deps.attachments.count();
  // The effect runs inside its task; the caller's connection and request
  // stay ambient for it, as when it ran inline.
  const caller = agentContext.getStore();
  const run = async () => {
    try {
      return await (caller ? agentContext.run(caller, runAction) : runAction());
    } catch (error) {
      deps.attachments.truncate(attachmentCount);
      throw error;
    }
  };
  if (!key) return await run();

  let outcome: EffectOutcome;
  try {
    outcome = await runEffectOnce(deps.tasks, deps.effects, {
      key,
      name: toolName,
      input,
      // An explicit `idempotencyKey` is the developer's assertion that
      // retrying the keyed side effect is safe, so only those claims may be
      // taken over when stale. Fallback `tool:${toolCallId}` keys never are.
      reclaimAfterMs:
        idempotencyKey !== undefined ? deps.pendingRetryLeaseMs : false,
      run
    });
  } catch (error) {
    return actionErrorEnvelope(error);
  }
  const event = { action: toolName, key, inputHash: stableHash(input) };
  switch (outcome.status) {
    case "replayed":
      deps.emit({
        type: "action:ledger:replayed",
        payload: event
      });
      return outcome.value;
    case "in-doubt": {
      deps.emit({
        type: "action:ledger:pending",
        payload: event
      });
      if (
        args.onReclaimableInDoubt &&
        idempotencyKey !== undefined &&
        deps.pendingRetryLeaseMs !== false
      ) {
        return args.onReclaimableInDoubt();
      }
      return actionPendingErrorEnvelope();
    }
    case "conflict":
      deps.emit({
        type: "action:ledger:conflict",
        payload: event
      });
      return actionKeyConflictEnvelope(toolName, key);
    case "unrecorded":
      deps.emit({
        type: "action:ledger:serialize_failed",
        payload: { action: toolName, key }
      });
      return outcome.value;
    case "reclaimed":
      deps.emit({
        type: "action:ledger:reclaimed",
        payload: { ...event, ageMs: outcome.ageMs }
      });
      break;
    case "ran":
      break;
  }
  deps.emit({
    type: "action:ledger:settled",
    payload: event
  });
  return outcome.value;
}
