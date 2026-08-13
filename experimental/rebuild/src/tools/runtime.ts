/**
 * ToolRuntime: the governed execution path. execute() runs
 * approval → claim → provider.execute → settle exactly once, generically.
 * Providers never see replays of settled work; the loop never touches the
 * Ledger directly (ADR 0002 — claim/settle is reachable only through here).
 *
 * Approval rides the log as tools-module pass-through entries
 * ("tools/approval-requested" / "tools/approval-verdict") — the extensibility
 * pattern from CONTEXT.md, exercised for real: the engine has no idea what an
 * approval is.
 */

import type {
  ApprovalDescriptor,
  ClaimKey,
  CorrelationId,
  Engine,
  Entry,
  Json,
  Ledger,
  NewEntry,
  Reconciler,
  RetryPolicy,
  SettleOutcome,
  ToolCall,
  ToolDescriptor,
  ToolMiddleware,
  ToolOutcome,
  ToolProvider,
  TurnInfo,
  Versioned
} from "../contract";
import { setClaimCorrelation } from "../engine/engine";
import { asClaimKey, asCorrelationId, asReconcilerName } from "../ids";

export const TOOLS_RECONCILER = asReconcilerName("tools");

export interface ApprovalRequestedPayload extends Versioned {
  readonly kind: "tools/approval-requested";
  readonly v: 1;
  readonly callId: string;
  readonly tool: string;
  readonly descriptor: ApprovalDescriptor;
}

export interface ApprovalVerdictPayload extends Versioned {
  readonly kind: "tools/approval-verdict";
  readonly v: 1;
  readonly callId: string;
  readonly verdict: "granted" | "rejected";
  readonly by?: string;
}

export interface ToolRuntimeOptions {
  readonly providers: readonly ToolProvider[];
  readonly middleware?: readonly ToolMiddleware[];
  readonly engine: Engine;
  /** How long a claim may sit unsettled before the tools reconciler runs. */
  readonly reconcileAfterMs?: number;
  readonly retry?: RetryPolicy;
}

export interface BoundToolRuntime {
  catalog(): Promise<readonly ToolDescriptor[]>;
  /** Bind the per-turn ambient state and get the contract ToolRuntime. */
  forTurn(turn: TurnInfo, signal: AbortSignal): {
    catalog(): Promise<readonly ToolDescriptor[]>;
    execute(call: ToolCall): Promise<ToolOutcome>;
  };
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  backoff: { initialMs: 250, factor: 4, maxMs: 60_000 }
};

export function claimKeyForCall(descriptor: ToolDescriptor, call: ToolCall): ClaimKey {
  if (descriptor.effect.effect === "mutating" && descriptor.effect.key !== undefined) {
    return asClaimKey(`tool:${descriptor.name}:${descriptor.effect.key(call.input)}`);
  }
  return asClaimKey(`tool:call:${call.callId}`);
}

export function correlationForCall(call: ToolCall): CorrelationId {
  return asCorrelationId(`tool:${call.callId}`);
}

export function createToolRuntime(opts: ToolRuntimeOptions): BoundToolRuntime {
  const { engine } = opts;
  const ledger: Ledger = engine.ledger;
  const reconcileAfterMs = opts.reconcileAfterMs ?? 30_000;
  const retry = opts.retry ?? DEFAULT_RETRY;

  // Compose middleware outermost-first over a dispatching provider.
  const providersByTool = new Map<string, ToolProvider>();
  const catalogCache = new Map<string, ToolDescriptor>();

  async function buildCatalog(): Promise<readonly ToolDescriptor[]> {
    if (catalogCache.size === 0) {
      for (const provider of opts.providers) {
        for (const descriptor of await provider.catalog()) {
          if (catalogCache.has(descriptor.name)) {
            throw new Error(`duplicate tool name in catalog: ${descriptor.name}`);
          }
          catalogCache.set(descriptor.name, descriptor);
          providersByTool.set(descriptor.name, provider);
        }
      }
    }
    return [...catalogCache.values()];
  }

  const dispatcher: ToolProvider = {
    name: "dispatch",
    catalog: buildCatalog,
    async execute(call, deps) {
      await buildCatalog();
      const provider = providersByTool.get(call.name);
      if (provider === undefined) {
        return {
          status: "failed",
          message: `unknown tool: ${call.name}`,
          retryable: false
        };
      }
      return provider.execute(call, deps);
    }
  };

  const composed = (opts.middleware ?? []).reduceRight(
    (next, mw) => mw(next),
    dispatcher
  );

  async function descriptorFor(name: string): Promise<ToolDescriptor | undefined> {
    await buildCatalog();
    return catalogCache.get(name);
  }

  /** Look for an approval verdict correlated with this call on the log. */
  async function approvalVerdict(
    call: ToolCall
  ): Promise<"granted" | "rejected" | null> {
    const view = engine.view();
    const rows = await view.query({
      kinds: ["tools/approval-verdict"],
      correlation: correlationForCall(call),
      limit: 1
    });
    if (rows.length === 0) return null;
    return (rows[0].payload as ApprovalVerdictPayload).verdict;
  }

  async function requestApproval(
    turn: TurnInfo,
    call: ToolCall,
    descriptor: ToolDescriptor
  ): Promise<ApprovalDescriptor> {
    const describe = descriptor.approval?.describe;
    const shown: ApprovalDescriptor = describe
      ? describe(call.input)
      : { title: `Approve ${descriptor.name}`, input: call.input };
    const payload: ApprovalRequestedPayload = {
      kind: "tools/approval-requested",
      v: 1,
      callId: call.callId,
      tool: descriptor.name,
      descriptor: shown
    };
    const entry: Record<string, unknown> = {
      origin: { module: "tools" },
      turn: turn.turnId,
      correlation: correlationForCall(call),
      payload
    };
    await engine.append([entry as unknown as NewEntry], {
      // Re-runs of the same step must not stack duplicate requests.
      idempotencyKey: `approval-request:${call.callId}`
    });
    return shown;
  }

  async function executeGoverned(
    turn: TurnInfo,
    signal: AbortSignal,
    call: ToolCall
  ): Promise<ToolOutcome> {
    const descriptor = await descriptorFor(call.name);
    if (descriptor === undefined) {
      return {
        status: "settled",
        attempt: 1,
        result: { status: "error", message: `unknown tool: ${call.name}`, retryable: false }
      };
    }

    // 1. Approval gate. "policy" without a decider is treated as "always"
    //    (conservative); a real policy source composes in as middleware.
    const mode = descriptor.approval?.mode ?? "never";
    if (mode !== "never") {
      const verdict = await approvalVerdict(call);
      if (verdict === null) {
        const approval = await requestApproval(turn, call, descriptor);
        return { status: "awaiting-approval", approval };
      }
      if (verdict === "rejected") {
        const key = claimKeyForCall(descriptor, call);
        const decision = await ledger.claim(claimReq(key, descriptor, call, turn));
        if (decision.outcome === "acquired") {
          await ledger.settle(key, { status: "aborted", reason: "approval rejected" });
        }
        return {
          status: "settled",
          attempt: 1,
          result: { status: "aborted", reason: "approval rejected" }
        };
      }
      // granted → fall through to execution
    }

    // 2. Read-only work: replay-safe, no claim.
    if (descriptor.effect.effect === "readonly") {
      const result = await runProvider(call, turn, signal);
      if (result.status === "pending") {
        // A readonly tool has nothing to settle later; treat as a contract
        // violation by the provider.
        return {
          status: "settled",
          attempt: 1,
          result: {
            status: "error",
            message: `readonly tool ${call.name} returned pending`,
            retryable: false
          }
        };
      }
      return {
        status: "settled",
        attempt: 1,
        result:
          result.status === "completed"
            ? { status: "ok", output: result.output }
            : { status: "error", message: result.message, retryable: result.retryable }
      };
    }

    // 3. Mutating work: claim → execute → settle.
    const key = claimKeyForCall(descriptor, call);
    const decision = await ledger.claim(claimReq(key, descriptor, call, turn));
    if (decision.outcome === "already-settled") {
      return { status: "settled", attempt: 2, result: decision.result };
    }
    if (decision.outcome === "duplicate-open") {
      // In flight (possibly from a previous wake). The reconciler or a
      // correlated settle will resolve it; the turn parks.
      return { status: "pending", correlation: correlationForCall(call) };
    }

    const result = await runProvider(call, turn, signal);
    if (result.status === "pending") {
      setClaimCorrelation(engine, key, result.correlation);
      return { status: "pending", correlation: result.correlation };
    }
    const settled: SettleOutcome =
      result.status === "completed"
        ? { status: "ok", output: result.output }
        : { status: "error", message: result.message, retryable: result.retryable };
    await ledger.settle(key, settled);
    return { status: "settled", attempt: 1, result: settled };
  }

  function claimReq(
    key: ClaimKey,
    descriptor: ToolDescriptor,
    call: ToolCall,
    turn: TurnInfo
  ) {
    return {
      key,
      effect: `tool/${descriptor.name}`,
      input: { callId: call.callId, name: call.name, input: call.input } as Json,
      origin: { module: "tools" },
      turn: turn.turnId,
      reconcileAfterMs,
      reconciler: TOOLS_RECONCILER
    };
  }

  async function runProvider(call: ToolCall, turn: TurnInfo, signal: AbortSignal) {
    return composed.execute(call, {
      turn,
      correlation: correlationForCall(call),
      signal,
      putBlob: (data, meta) => engine.blobs.putBlob(data, meta)
    });
  }

  // The tools reconciler: liveness for claims this runtime opened.
  const reconciler: Reconciler = {
    policy: retry,
    async handle(deps) {
      const payload = deps.claim.payload;
      const input = payload.input as { callId: string; name: string; input: Json };
      const descriptor = await descriptorFor(input.name);
      if (descriptor === undefined || descriptor.effect.effect !== "mutating") {
        return {
          action: "settle",
          result: { status: "expired", reason: "tool no longer in catalog" }
        };
      }
      if (descriptor.effect.retry === "at-most-once") {
        // Repeating is worse than losing: surface the ambiguity, terminally.
        return {
          action: "settle",
          result: {
            status: "expired",
            reason: "unsettled at-most-once effect; not re-executed"
          }
        };
      }
      // at-least-once: re-execute. The provider is only re-run for claims that
      // never settled, so double execution is confined to the two-generals gap
      // the RetryContract declared safe.
      const call: ToolCall = {
        callId: input.callId,
        name: input.name,
        input: input.input
      };
      const turnStub: TurnInfo = {
        turnId: (deps.claim.turn ?? "") as TurnInfo["turnId"],
        branch: deps.claim.ref.branch,
        trigger: deps.claim.ref,
        status: "active",
        attempt: deps.attempt,
        startedAt: deps.claim.at
      };
      const result = await runProvider(call, turnStub, new AbortController().signal);
      if (result.status === "completed") {
        return { action: "settle", result: { status: "ok", output: result.output } };
      }
      if (result.status === "pending") {
        return { action: "wait", afterMs: reconcileAfterMs };
      }
      if (!result.retryable) {
        return {
          action: "settle",
          result: { status: "error", message: result.message, retryable: false }
        };
      }
      return { action: "retry" };
    }
  };
  ledger.reconciler(TOOLS_RECONCILER, reconciler);

  return {
    catalog: buildCatalog,
    forTurn(turn, signal) {
      return {
        catalog: buildCatalog,
        execute: (call) => executeGoverned(turn, signal, call)
      };
    }
  };
}

/** Payload appended by an async provider's inbound half to settle a pending call. */
export interface ToolSettlementPayload extends Versioned {
  readonly kind: "tools/settlement";
  readonly v: 1;
  readonly output: Json;
  readonly isError?: boolean;
}

/**
 * Runtime hook: when a correlated entry lands for an open claim, settle it.
 * Returns true if a claim was settled by this entry.
 */
export async function settlePendingFromEntry(
  engine: Engine,
  openClaimKeyByCorrelation: (correlation: string) => ClaimKey | null,
  entry: Entry
): Promise<boolean> {
  if (entry.correlation === undefined) return false;
  const key = openClaimKeyByCorrelation(entry.correlation);
  if (key === null) return false;
  const payload = entry.payload as Partial<ToolSettlementPayload>;
  if (payload.kind !== "tools/settlement") return false;
  await engine.ledger.settle(
    key,
    payload.isError === true
      ? { status: "error", message: String(payload.output), retryable: false }
      : { status: "ok", output: (payload.output ?? null) as Json }
  );
  return true;
}
