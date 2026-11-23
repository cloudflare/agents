/**
 * The action API: `action()` declares a typed tool with policy (approval,
 * permissions, idempotency, timeout), and `getActions()` returns them for
 * Think to compile into the turn's tools.
 */

import type { FlexibleSchema, InferSchema, ModelMessage } from "ai";
import type { Think } from "./think";

const ACTION_BRAND: unique symbol = Symbol.for(
  "cf.think.action"
) as typeof ACTION_BRAND;

export type ActionKind =
  | "server"
  | "client"
  | "approval-gated"
  | "durable-pause"
  | "delegated-agent";

export interface ActionContext {
  /** The agent instance currently executing the action. */
  agent: Think;
  env: Cloudflare.Env;
  /** Current turn request id. */
  requestId: string;
  toolCallId: string;
  /** Model messages visible to the tool call. */
  messages: ReadonlyArray<ModelMessage>;
  /** Combined action timeout and turn abort signal. */
  signal: AbortSignal;
  /**
   * Record an advisory delivery hint for this turn's final reply (voice note,
   * card, email draft, ...). Does not change the model-visible tool output.
   * No-op for approval/permission/idempotency policy evaluation and for
   * durable-pause approved-action resumes (their reply is delivered by a
   * later continuation turn in v1).
   */
  attachReply(attachment: ReplyAttachment): void;
}

/**
 * The attachment shape accepted by {@link ActionContext.attachReply}. An open
 * union: the named variants give autocomplete for common channels, and the
 * trailing `{ type: string; [k]: unknown }` keeps it extensible. Advisory only
 * — surfaces that don't recognize a `type` ignore it.
 */
export type ReplyAttachment =
  | { type: "voice_note" }
  | { type: "email_draft"; subject?: string; to?: string[] }
  | { type: "card"; payload: unknown }
  | { type: string; [k: string]: unknown };

export type ActionApprovalPolicy<Input> =
  | boolean
  | ((args: {
      input: Input;
      ctx: ActionContext;
    }) => boolean | Promise<boolean>);

export type ActionPermissionSpec<Input> =
  | readonly string[]
  | ((args: {
      input: Input;
      ctx: ActionContext;
    }) => readonly string[] | Promise<readonly string[]>);

export type ActionIdempotencyKey<Input> =
  | string
  | ((args: { input: Input; ctx: ActionContext }) => string | Promise<string>);

export type ActionAuthorizationDecision =
  | boolean
  | {
      allowed: boolean;
      reason?: string;
      grantedPermissions?: readonly string[];
    };

export interface ActionAuthorizationContext {
  requestId: string;
  toolCallId: string;
  action: string;
  kind: ActionKind;
  input: unknown;
  requiredPermissions: readonly string[];
  grantedPermissions?: readonly string[];
  messages: ReadonlyArray<ModelMessage>;
  agent: Think;
  env: Cloudflare.Env;
}

export interface ActionApprovalDescriptor {
  requestId: string;
  toolCallId: string;
  action: string;
  summary: string;
  input: unknown;
  permissions: string[];
  risk?: "low" | "medium" | "high";
  kind: "approval-gated" | "durable-pause";
}

export interface ActionConfig<
  InputSchema extends FlexibleSchema = FlexibleSchema,
  Output = unknown
> {
  /** Defaults to the registration key when returned from getActions(). */
  name?: string;
  description: string;
  inputSchema: InputSchema;
  /** Reserved metadata; output validation is not enforced yet. */
  outputSchema?: FlexibleSchema<Output>;
  /**
   * Stable key used to replay settled action results without re-running side
   * effects. Use domain identifiers that survive recovery retries (for example,
   * an order id or inbound event id); avoid request ids, timestamps, and random
   * values.
   */
  idempotencyKey?: ActionIdempotencyKey<InferSchema<InputSchema>>;
  permissions?: ActionPermissionSpec<InferSchema<InputSchema>>;
  approval?: ActionApprovalPolicy<InferSchema<InputSchema>>;
  approvalSummary?: string;
  approvalRisk?: "low" | "medium" | "high";
  timeoutMs?: number;
  kind?: ActionKind;
  execute(
    input: InferSchema<InputSchema>,
    ctx: ActionContext
  ): Promise<Output> | Output;
}

export interface Action<
  InputSchema extends FlexibleSchema = FlexibleSchema,
  Output = unknown
> {
  readonly [ACTION_BRAND]: true;
  readonly config: ActionConfig<InputSchema, Output>;
}

export function action<
  const InputSchema extends FlexibleSchema,
  Output = unknown
>(config: ActionConfig<InputSchema, Output>): Action<InputSchema, Output> {
  if (config.kind === "durable-pause" && config.approval === false) {
    throw new Error(
      `Action "${config.name ?? "(anonymous)"}": kind "durable-pause" with ` +
        `approval: false never parks for approval, defeating the purpose. ` +
        `Use kind "server" for an inline action, or omit approval (or set a ` +
        `predicate) to gate when it parks.`
    );
  }
  const descriptor: Action<InputSchema, Output> = {
    [ACTION_BRAND]: true,
    config: Object.freeze({ ...config })
  };
  return Object.freeze(descriptor);
}

export function isAction(value: unknown): value is Action {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [ACTION_BRAND]?: unknown })[ACTION_BRAND] === true
  );
}

/** @internal What a compiled action tool carries for approval descriptors. */
export type CompiledActionMetadata = {
  actionName: string;
  summary: string;
  permissions?: string[];
  risk?: "low" | "medium" | "high";
  kind: "approval-gated" | "durable-pause";
};

/** @internal An authorization decision with defaults applied. */
export type NormalizedActionAuthorization = {
  allowed: boolean;
  reason?: string;
  grantedPermissions?: readonly string[];
};
