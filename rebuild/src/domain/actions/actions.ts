import { z } from "zod";
import { NotFoundError, TimeoutError, ValidationError, toErrorValue, type ErrorValue } from "../../kernel/errors.js";
import type { EventBus } from "../../kernel/events.js";
import { stableHash, type IdSource } from "../../kernel/ids.js";
import { normalizeJson, truncateForModel, tryNormalizeJson } from "../../kernel/json.js";
import type { Clock } from "../../ports/clock.js";
import { scoped, type KeyValueStore } from "../../ports/storage.js";
import type { ChatMessage } from "../messages/model.js";
import type { Tool, ToolExecutionContext, ToolSet } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Descriptor (audit 12 §"The descriptor")
// ---------------------------------------------------------------------------

export type ActionKind = "server" | "approval-gated" | "durable-pause";
export type ApprovalRisk = "low" | "medium" | "high";

export type ReplyAttachment = { type: string; [k: string]: unknown };

export interface ActionContext {
  requestId: string;
  toolCallId: string;
  messages: ReadonlyArray<ChatMessage>;
  /** Aborts on turn cancel OR timeoutMs. */
  signal: AbortSignal;
  attachReply(attachment: ReplyAttachment): void;
}

/**
 * Input/Output default to `any` for the same reason Tool's do (types.ts): a
 * heterogeneous `Record<string, Action>` must accept concretely-typed actions.
 */
export interface ActionConfig<Input = any, Output = any> {
  description: string;
  inputSchema: z.ZodType<Input>;
  /** Method shorthand for bivariant parameter checking (see Tool.execute). */
  execute(input: Input, ctx: ActionContext): Output | Promise<Output>;
  /** Defaults to the map key passed to compile(). */
  name?: string;
  idempotencyKey?: string | ((args: { input: Input }) => string);
  permissions?: readonly string[] | ((args: { input: Input }) => readonly string[]);
  approval?: boolean | ((args: { input: Input }) => boolean | Promise<boolean>);
  /** Default: description. */
  approvalSummary?: string;
  approvalRisk?: ApprovalRisk;
  /** Inferred when omitted: approval set → approval-gated, else server. */
  kind?: ActionKind;
  /** Default 30_000. */
  timeoutMs?: number;
}

const ACTION_BRAND = Symbol.for("rebuild.action");

export interface Action<Input = any, Output = any> extends ActionConfig<Input, Output> {
  kind: ActionKind;
  readonly [ACTION_BRAND]: true;
}

export function action<I, O>(config: ActionConfig<I, O>): Action<I, O> {
  const kind: ActionKind = config.kind ?? (config.approval !== undefined ? "approval-gated" : "server");
  if (kind === "durable-pause" && config.approval === undefined) {
    throw new ValidationError(
      `Action "${config.name ?? config.description}" is durable-pause but has no approval policy: an action that would never park is rejected`
    );
  }
  return { ...config, kind, [ACTION_BRAND]: true };
}

export function isAction(v: unknown): v is Action {
  return typeof v === "object" && v !== null && (v as Record<PropertyKey, unknown>)[ACTION_BRAND] === true;
}

// ---------------------------------------------------------------------------
// Authorization (audit 12 §"Authorization decisions")
// ---------------------------------------------------------------------------

export type AuthorizationDecision =
  | boolean
  | { allowed: boolean; reason?: string; grantedPermissions?: readonly string[] };

/**
 * Minimal structural stand-in for the turn loop's TurnContext (doc 09); the
 * composition layer passes its richer object structurally. Actions must not
 * import from domain/turn.
 */
export interface ActionTurnContext {
  requestId: string;
  trigger?: string;
  continuation?: boolean;
  channelId?: string;
  messages?: readonly unknown[];
}

export interface ActionAuthorizationContext {
  requestId: string;
  toolCallId: string;
  action: string;
  kind: ActionKind;
  input: unknown;
  requiredPermissions: readonly string[];
  /** undefined = full grant. */
  grantedPermissions?: readonly string[];
}

// ---------------------------------------------------------------------------
// Approval descriptors & parked executions (audit 12 §"Parked executions API")
// ---------------------------------------------------------------------------

export interface ActionApprovalDescriptor {
  requestId: string;
  toolCallId: string;
  action: string;
  summary: string;
  input: unknown;
  permissions: readonly string[];
  risk?: ApprovalRisk;
  kind: "approval-gated" | "durable-pause";
}

export interface PendingApproval {
  executionId: string;
  descriptor: ActionApprovalDescriptor;
  input: unknown;
  requestId: string;
  toolCallId: string;
  status: "parked" | "approved" | "rejected";
  createdAt: number;
  settledAt?: number;
  output?: unknown;
  rejection?: ErrorValue;
}

export type ParkedResolution = {
  toolCallId: string;
  requestId: string;
  output?: unknown;
  rejection?: ErrorValue;
};

/** The error value the turn layer emits when an approval-gated call is rejected. */
export function actionRejectionErrorValue(actionName: string, reason?: string): { error: ErrorValue } {
  return { error: { name: "ActionRejectedError", message: reason ?? `Action "${actionName}" was rejected` } };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ActionTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ActionService {
  /** Wraps the per-call pipeline; call per turn. */
  compile(actions: Record<string, Action>): ToolSet;
  /** Caches the turn-level grant for ctx.requestId (default: full grant). */
  authorizeTurnOnce(ctx: ActionTurnContext): Promise<void>;
  /** Durably parks a durable-pause execution; returns the executionId. */
  park(descriptor: ActionApprovalDescriptor): string;
  pendingApprovals(executionId?: string): PendingApproval[];
  /** Runs execute once (idempotent — second call no-op) and fires onResolved. */
  approveExecution(executionId: string): Promise<unknown>;
  /** Settles without executing; fires onResolved with the rejection. */
  rejectExecution(executionId: string, reason?: string): Promise<void>;
  /** Deep-copied reply attachments, per turn or across all turns. */
  attachments(requestId?: string): ReplyAttachment[];
  /** Drops per-turn grant/attachment state. */
  clearTurn(requestId: string): void;
}

export interface ActionServiceDeps {
  store: KeyValueStore; // prefixes "action:ledger:", "action:parked:"
  clock: Clock;
  ids: IdSource;
  bus: EventBus;
  authorizeTurn?: (ctx: ActionTurnContext) => AuthorizationDecision | Promise<AuthorizationDecision>;
  authorizeAction?: (ctx: ActionAuthorizationContext) => AuthorizationDecision | Promise<AuthorizationDecision>;
  /** Reclaim lease for stale pending rows with an explicit key; false disables. */
  pendingRetryLeaseMs?: number | false;
  onResolved?: (executionId: string, resolution: ParkedResolution) => void | Promise<void>;
  /** Injectable for deterministic timeout tests. */
  timers?: ActionTimers;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PENDING_RETRY_LEASE_MS = 300_000;
const MAX_OUTPUT_CHARS = 16_000;
const MAX_ATTACHMENTS_PER_TURN = 20;

interface LedgerRow {
  status: "pending" | "settled";
  inputHash: string;
  createdAt: number;
  settledAt?: number;
  output?: unknown;
}

interface Grant {
  allowed: boolean;
  full: boolean;
  granted: readonly string[];
  reason?: string;
}

const defaultTimers: ActionTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

function toGrant(decision: AuthorizationDecision): Grant {
  if (decision === true) return { allowed: true, full: true, granted: [] };
  if (decision === false) return { allowed: false, full: false, granted: [] };
  if (!decision.allowed) return { allowed: false, full: false, granted: [], reason: decision.reason };
  if (decision.grantedPermissions !== undefined) {
    return { allowed: true, full: false, granted: [...decision.grantedPermissions], reason: decision.reason };
  }
  return { allowed: true, full: true, granted: [] };
}

function resolvePermissions(act: Action, input: unknown): readonly string[] {
  if (act.permissions === undefined) return [];
  if (typeof act.permissions === "function") return act.permissions({ input });
  return act.permissions;
}

/** Normalizes to plain JSON and truncates oversized outputs to a string. */
function normalizeOutput(raw: unknown): unknown {
  const normalized = normalizeJson(raw) ?? null;
  const json = JSON.stringify(normalized);
  if (typeof json === "string" && json.length > MAX_OUTPUT_CHARS) {
    return truncateForModel(json, MAX_OUTPUT_CHARS).text;
  }
  return normalized;
}

export function createActionService(deps: ActionServiceDeps): ActionService {
  const ledger = scoped(deps.store, "action:ledger:");
  const parked = scoped(deps.store, "action:parked:");
  const timers = deps.timers ?? defaultTimers;
  const lease = deps.pendingRetryLeaseMs ?? DEFAULT_PENDING_RETRY_LEASE_MS;

  /** name → action, filled by compile(); approveExecution resolves through it. */
  const registry = new Map<string, Action>();
  /** requestId → cached turn grant. */
  const grants = new Map<string, Grant>();
  /** requestId → committed reply attachments. */
  const turnAttachments = new Map<string, ReplyAttachment[]>();

  async function ensureGrant(ctx: ActionTurnContext): Promise<Grant> {
    const cached = grants.get(ctx.requestId);
    if (cached) return cached;
    const decide = deps.authorizeTurn ?? (() => true as const);
    const grant = toGrant(await decide(ctx));
    grants.set(ctx.requestId, grant);
    return grant;
  }

  async function authorizeCall(
    name: string,
    act: Action,
    input: unknown,
    required: readonly string[],
    toolCtx: ToolExecutionContext
  ): Promise<{ allowed: boolean; reason?: string }> {
    const grant = await ensureGrant({ requestId: toolCtx.requestId, messages: toolCtx.messages });
    if (deps.authorizeAction) {
      const decision = toGrant(
        await deps.authorizeAction({
          requestId: toolCtx.requestId,
          toolCallId: toolCtx.toolCallId,
          action: name,
          kind: act.kind,
          input,
          requiredPermissions: required,
          grantedPermissions: grant.full ? undefined : grant.granted,
        })
      );
      return { allowed: decision.allowed, reason: decision.reason };
    }
    if (!grant.allowed) return { allowed: false, reason: grant.reason };
    if (grant.full) return { allowed: true };
    const missing = required.filter((p) => !grant.granted.includes(p));
    return missing.length === 0 ? { allowed: true } : { allowed: false };
  }

  /** Races execute against its timeout; the action signal aborts on either turn-abort or timeout. */
  function callWithTimeout(name: string, act: Action, input: unknown, actionCtx: ActionContext, abort: (reason: unknown) => void): Promise<unknown> {
    const timeoutMs = act.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const handle = timers.setTimeout(() => {
        const err = new TimeoutError(`Action "${name}" timed out after ${timeoutMs}ms`);
        abort(err);
        reject(err);
      }, timeoutMs);
      Promise.resolve()
        .then(() => act.execute(input, actionCtx))
        .then(
          (value) => {
            timers.clearTimeout(handle);
            resolve(value);
          },
          (err) => {
            timers.clearTimeout(handle);
            reject(err);
          }
        );
    });
  }

  /**
   * Pipeline steps 3–4 (audit 12): ledger/idempotency, then execute with a
   * combined abort signal and attachment collection. Also the post-approval
   * path for parked durable-pause executions.
   */
  async function runLedgered(name: string, act: Action, input: unknown, toolCtx: ToolExecutionContext): Promise<unknown> {
    const hasExplicitKey = act.idempotencyKey !== undefined;
    const key =
      typeof act.idempotencyKey === "function"
        ? act.idempotencyKey({ input })
        : act.idempotencyKey ?? toolCtx.toolCallId;
    const ledgerKey = `${name}:${key}`;

    const existing = ledger.get<LedgerRow>(ledgerKey);
    if (existing?.status === "settled") {
      // Replay: the key is the identity even if the input hash differs.
      // Attachments are NOT re-fired.
      return existing.output;
    }
    if (existing?.status === "pending") {
      const stale = lease !== false && deps.clock.now() - existing.createdAt >= lease;
      if (!(hasExplicitKey && stale)) {
        return {
          error: { name: "ActionPendingError", message: `Action "${name}" (key "${key}") is already pending` },
        };
      }
      // Stale row under an explicit key: reclaim (treat as ours, re-run).
    }

    const createdAt = deps.clock.now();
    ledger.put<LedgerRow>(ledgerKey, { status: "pending", inputHash: stableHash(input), createdAt });

    // Attachment buffer: live only while this call's execute runs; committed
    // on success, discarded on failure.
    const buffer: ReplyAttachment[] = [];
    let attachActive = true;
    const attachReply = (attachment: ReplyAttachment): void => {
      if (!attachActive) return;
      const committed = turnAttachments.get(toolCtx.requestId)?.length ?? 0;
      if (committed + buffer.length >= MAX_ATTACHMENTS_PER_TURN) return;
      const normalized = tryNormalizeJson(attachment);
      if (normalized.ok) buffer.push(normalized.value as ReplyAttachment);
    };

    // Combined signal: aborts on turn cancel OR timeout.
    const controller = new AbortController();
    const onTurnAbort = (): void => controller.abort(toolCtx.signal.reason);
    if (toolCtx.signal.aborted) {
      controller.abort(toolCtx.signal.reason);
    } else {
      toolCtx.signal.addEventListener("abort", onTurnAbort, { once: true });
    }

    const actionCtx: ActionContext = {
      requestId: toolCtx.requestId,
      toolCallId: toolCtx.toolCallId,
      messages: toolCtx.messages,
      signal: controller.signal,
      attachReply,
    };

    try {
      const raw = await callWithTimeout(name, act, input, actionCtx, (reason) => controller.abort(reason));
      const output = normalizeOutput(raw);
      ledger.put<LedgerRow>(ledgerKey, {
        status: "settled",
        inputHash: stableHash(input),
        createdAt,
        settledAt: deps.clock.now(),
        output,
      });
      const committed = turnAttachments.get(toolCtx.requestId) ?? [];
      for (const attachment of buffer) {
        if (committed.length >= MAX_ATTACHMENTS_PER_TURN) break;
        committed.push(attachment);
      }
      turnAttachments.set(toolCtx.requestId, committed);
      return output;
    } catch (err) {
      // Throw or timeout: delete the row so a retry re-runs cleanly.
      ledger.delete(ledgerKey);
      return { error: toErrorValue(err) };
    } finally {
      attachActive = false;
      toolCtx.signal.removeEventListener("abort", onTurnAbort);
    }
  }

  /**
   * Full per-call pipeline. `withAuthorization` is false for durable-pause
   * tools: their compiled execute is the post-approval pipeline (steps 3–4);
   * step 1 for them happens at the turn layer before parking.
   */
  async function runAction(
    name: string,
    act: Action,
    rawInput: unknown,
    toolCtx: ToolExecutionContext,
    withAuthorization: boolean
  ): Promise<unknown> {
    const parsed = act.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return { error: { name: "ActionInputValidationError", message: parsed.error.message } };
    }
    const input: unknown = parsed.data;

    if (withAuthorization) {
      const required = resolvePermissions(act, input);
      const decision = await authorizeCall(name, act, input, required, toolCtx);
      if (!decision.allowed) {
        return {
          error: {
            name: "ActionAuthorizationError",
            message: decision.reason ?? `Action "${name}" is not authorized for this turn`,
            permissions: [...required],
          },
        };
      }
    }

    return runLedgered(name, act, input, toolCtx);
  }

  function compileOne(name: string, act: Action): Tool {
    const durable = act.kind === "durable-pause";
    const approval = act.approval;
    const needsApproval: Tool["needsApproval"] = durable
      ? true
      : act.kind === "approval-gated"
        ? typeof approval === "function"
          ? (input: unknown) => approval({ input })
          : approval ?? false
        : undefined;

    return {
      description: act.description,
      inputSchema: act.inputSchema,
      needsApproval,
      metadata: {
        action: name,
        kind: act.kind,
        approvalSummary: act.approvalSummary ?? act.description,
        approvalRisk: act.approvalRisk,
        ...(durable ? { durablePause: true } : {}),
        resolvePermissions: (input: unknown) => resolvePermissions(act, input),
      },
      async execute(input: unknown, toolCtx: ToolExecutionContext) {
        return runAction(name, act, input, toolCtx, !durable);
      },
    };
  }

  function getParked(executionId: string): PendingApproval {
    const row = parked.get<PendingApproval>(executionId);
    if (!row) throw new NotFoundError(`No parked execution "${executionId}"`);
    return row;
  }

  return {
    compile(actions) {
      const tools: ToolSet = {};
      for (const [mapKey, act] of Object.entries(actions)) {
        if (!isAction(act)) {
          throw new ValidationError(`compile(): "${mapKey}" is not an action; wrap it with action()`);
        }
        const name = act.name ?? mapKey;
        registry.set(name, act);
        tools[name] = compileOne(name, act);
      }
      return tools;
    },

    async authorizeTurnOnce(ctx) {
      await ensureGrant(ctx);
    },

    park(descriptor) {
      const executionId = deps.ids.newId("exec");
      const row: PendingApproval = {
        executionId,
        descriptor,
        input: descriptor.input,
        requestId: descriptor.requestId,
        toolCallId: descriptor.toolCallId,
        status: "parked",
        createdAt: deps.clock.now(),
      };
      parked.put(executionId, row);
      deps.bus.emit("tool:approval:parked", { executionId, action: descriptor.action });
      return executionId;
    },

    pendingApprovals(executionId) {
      const rows = [...parked.list<PendingApproval>().values()].filter((row) => row.status === "parked");
      return executionId === undefined ? rows : rows.filter((row) => row.executionId === executionId);
    },

    async approveExecution(executionId) {
      const row = getParked(executionId);
      if (row.status === "approved") return row.output;
      if (row.status === "rejected") return undefined;

      const act = registry.get(row.descriptor.action);
      if (!act) {
        throw new NotFoundError(`Action "${row.descriptor.action}" is not registered; call compile() first`);
      }

      const toolCtx: ToolExecutionContext = {
        toolCallId: row.toolCallId,
        requestId: row.requestId,
        messages: [],
        signal: new AbortController().signal,
      };
      const output = await runAction(row.descriptor.action, act, row.input, toolCtx, false);
      parked.put<PendingApproval>(executionId, {
        ...row,
        status: "approved",
        output,
        settledAt: deps.clock.now(),
      });
      deps.bus.emit("tool:approval:approved", { executionId, action: row.descriptor.action });
      await deps.onResolved?.(executionId, { toolCallId: row.toolCallId, requestId: row.requestId, output });
      return output;
    },

    async rejectExecution(executionId, reason) {
      const row = getParked(executionId);
      if (row.status !== "parked") return; // idempotent no-op
      const rejection = actionRejectionErrorValue(row.descriptor.action, reason).error;
      parked.put<PendingApproval>(executionId, {
        ...row,
        status: "rejected",
        rejection,
        settledAt: deps.clock.now(),
      });
      deps.bus.emit("tool:approval:rejected", { executionId, action: row.descriptor.action, reason });
      await deps.onResolved?.(executionId, { toolCallId: row.toolCallId, requestId: row.requestId, rejection });
    },

    attachments(requestId) {
      if (requestId !== undefined) {
        return structuredClone(turnAttachments.get(requestId) ?? []);
      }
      const all: ReplyAttachment[] = [];
      for (const list of turnAttachments.values()) all.push(...list);
      return structuredClone(all);
    },

    clearTurn(requestId) {
      grants.delete(requestId);
      turnAttachments.delete(requestId);
    },
  };
}
