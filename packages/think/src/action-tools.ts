/**
 * How a turn compiles the agent's actions (`getActions()`) into AI SDK tools:
 * authorization through `authorizeAction`, the approval gate, the timeout
 * and abort race, and the hand-off to the action ledger or a durable pause.
 */

import type { ModelMessage, ToolSet, UIMessage } from "ai";
import { tool } from "ai";
import {
  isAction,
  type Action,
  type ActionApprovalDescriptor,
  type ActionApprovalPolicy,
  type ActionAuthorizationContext,
  type ActionAuthorizationDecision,
  type ActionContext,
  type ActionIdempotencyKey,
  type ActionKind,
  type ActionPermissionSpec,
  type CompiledActionMetadata,
  type NormalizedActionAuthorization
} from "./actions";
import type { Think } from "./think";

/**
 * What compiled action tools call on their agent.
 *
 * @internal
 */
export interface ActionToolHost {
  readonly agent: Think;
  /** The agent's bindings, read each time an action runs. */
  env(): Cloudflare.Env;
  /** Request id of the admitted turn, or `""`. */
  requestId(): string;
  /** Whether a human already approved this call (its transcript part). */
  isApproved(toolCallId: string): boolean;
  /** Permissions `authorizeTurn` granted the current turn. */
  grantedPermissions(): readonly string[] | undefined;
  authorizeAction(
    ctx: ActionAuthorizationContext
  ): ActionAuthorizationDecision | Promise<ActionAuthorizationDecision>;
  recordApprovalDescriptor(
    toolCallId: string,
    descriptor: ActionApprovalDescriptor
  ): void;
  recordReplyAttachment(
    requestId: string,
    attachment: unknown,
    actionName: string
  ): void;
  /** Run the action through the action ledger (claim, run once, record). */
  runLedgered(args: {
    toolName: string;
    idempotencyKey: ActionIdempotencyKey<unknown> | undefined;
    input: unknown;
    ctx: ActionContext;
    runAction: () => Promise<unknown>;
  }): Promise<unknown>;
  /** Park a durable-pause action for approval; returns the tool output. */
  parkDurablePause(args: {
    toolName: string;
    input: unknown;
    ctx: ActionContext;
    summary: string;
    permissions: string[];
    risk?: "low" | "medium" | "high";
  }): unknown;
}

/** @internal */
export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const ACTION_OUTPUT_MAX_CHARS = 20_000;

/** @internal */
export function actionErrorEnvelope(error: unknown): {
  error: { name: string; message: string };
} {
  return {
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error)
    }
  };
}

/** @internal */
export function actionAuthorizationErrorEnvelope(
  reason: string | undefined,
  permissions: string[]
): {
  error: { name: string; message: string; permissions: string[] };
} {
  return {
    error: {
      name: "ActionAuthorizationError",
      message: reason ?? "Action is not authorized",
      permissions
    }
  };
}

/** @internal */
export function actionApprovalInputErrorEnvelope(): {
  error: { name: string; message: string };
} {
  return {
    error: {
      name: "ActionApprovalInputError",
      message: "Approved action input cannot be changed by beforeToolCall"
    }
  };
}

/** @internal */
export function safeStringifyActionOutput(output: unknown): {
  value?: string;
  lossy: boolean;
  error?: string;
} {
  const seen = new WeakSet<object>();
  let lossy = false;
  try {
    const value = JSON.stringify(output, (_key, value: unknown) => {
      if (typeof value === "bigint") {
        lossy = true;
        return `${value.toString()}n`;
      }
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          lossy = true;
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    });
    return { value, lossy };
  } catch (error) {
    return {
      lossy: true,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** @internal */
export function prepareActionOutputForModel(output: unknown): unknown {
  if (typeof output === "string") {
    if (output.length <= ACTION_OUTPUT_MAX_CHARS) return output;
    return `${output.slice(0, ACTION_OUTPUT_MAX_CHARS)}\n\n[truncated ${output.length - ACTION_OUTPUT_MAX_CHARS} chars]`;
  }

  const serialized = safeStringifyActionOutput(output);
  if (serialized.error) {
    return {
      serialized: false,
      error: serialized.error
    };
  }
  if (serialized.value === undefined) return output;
  if (serialized.value.length <= ACTION_OUTPUT_MAX_CHARS) {
    if (!serialized.lossy) return output;
    return JSON.parse(serialized.value) as unknown;
  }

  return {
    truncated: true,
    chars: serialized.value.length,
    preview: `${serialized.value.slice(0, ACTION_OUTPUT_MAX_CHARS)}\n\n[truncated ${serialized.value.length - ACTION_OUTPUT_MAX_CHARS} chars]`
  };
}

/** @internal */
export function createActionAbortSignal(
  turnSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abortFromTurn = () => controller.abort(turnSignal?.reason);

  if (turnSignal?.aborted) {
    abortFromTurn();
  } else {
    turnSignal?.addEventListener("abort", abortFromTurn, { once: true });
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeout = setTimeout(() => {
        controller.abort(new Error(`Action timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeout) clearTimeout(timeout);
      turnSignal?.removeEventListener("abort", abortFromTurn);
    }
  };
}

/** @internal */
export function normalizeActionAuthorization(
  decision: ActionAuthorizationDecision
): NormalizedActionAuthorization {
  if (typeof decision === "boolean") {
    return { allowed: decision };
  }
  return {
    allowed: decision.allowed,
    ...(decision.reason !== undefined && { reason: decision.reason }),
    ...(decision.grantedPermissions !== undefined && {
      grantedPermissions: [...decision.grantedPermissions]
    })
  };
}

/** @internal */
export function approvedActionInputs(
  messages: readonly UIMessage[]
): Map<string, unknown> {
  const approved = new Map<string, unknown>();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (typeof part !== "object" || part === null) continue;
      const record = part as Record<string, unknown>;
      const toolCallId =
        typeof record.toolCallId === "string" ? record.toolCallId : undefined;
      if (!toolCallId) continue;
      const approval = record.approval as
        | { approved?: unknown; descriptor?: unknown }
        | undefined;
      if (approval?.approved !== true) continue;
      const descriptor = approval.descriptor as
        | { input?: unknown; action?: unknown }
        | undefined;
      if (typeof descriptor?.action !== "string") continue;
      approved.set(
        toolCallId,
        "input" in descriptor ? descriptor.input : record.input
      );
    }
  }
  return approved;
}

async function resolveActionPermissions(
  spec: ActionPermissionSpec<unknown> | undefined,
  input: unknown,
  ctx: ActionContext
): Promise<string[]> {
  if (spec === undefined) return [];
  const policyCtx = actionContextWithoutReply(ctx);
  const permissions =
    typeof spec === "function" ? await spec({ input, ctx: policyCtx }) : spec;
  return [...permissions];
}

/** @internal */
export function actionContextWithoutReply(ctx: ActionContext): ActionContext {
  return {
    ...ctx,
    attachReply: () => {}
  };
}

async function authorizeActionCall(
  host: ActionToolHost,
  options: {
    actionName: string;
    kind: ActionKind;
    input: unknown;
    ctx: ActionContext;
    permissions?: ActionPermissionSpec<unknown>;
  }
): Promise<NormalizedActionAuthorization & { permissions: string[] }> {
  const permissions = await resolveActionPermissions(
    options.permissions,
    options.input,
    options.ctx
  );
  const decision = await host.authorizeAction({
    requestId: options.ctx.requestId,
    toolCallId: options.ctx.toolCallId,
    action: options.actionName,
    kind: options.kind,
    input: options.input,
    requiredPermissions: permissions,
    grantedPermissions: host.grantedPermissions(),
    messages: options.ctx.messages,
    agent: host.agent,
    env: host.env()
  });
  return {
    ...normalizeActionAuthorization(decision),
    permissions
  };
}

/** @internal */
export function compileActionTools(
  actions: Record<string, Action>,
  host: ActionToolHost,
  metadata: Map<string, CompiledActionMetadata>
): ToolSet {
  const tools: ToolSet = {};
  for (const [registrationName, descriptor] of Object.entries(actions)) {
    if (!isAction(descriptor)) {
      throw new Error(
        `getActions() entry "${registrationName}" must be created with action().`
      );
    }
    const toolName = descriptor.config.name ?? registrationName;
    const kind =
      descriptor.config.kind ??
      (descriptor.config.approval ? "approval-gated" : "server");
    if (kind === "approval-gated" || kind === "durable-pause") {
      const staticPermissions = Array.isArray(descriptor.config.permissions)
        ? [...descriptor.config.permissions]
        : undefined;
      metadata.set(toolName, {
        actionName: toolName,
        summary:
          descriptor.config.approvalSummary ?? descriptor.config.description,
        ...(staticPermissions !== undefined && {
          permissions: staticPermissions
        }),
        ...(descriptor.config.approvalRisk !== undefined && {
          risk: descriptor.config.approvalRisk
        }),
        kind
      });
    }
    tools[toolName] = actionToTool(host, descriptor, toolName, kind);
  }
  return tools;
}

function actionToTool(
  host: ActionToolHost,
  descriptor: Action,
  toolName: string,
  kind: ActionKind
): ToolSet[string] {
  const config = descriptor.config;
  const executeAction = config.execute as (
    input: unknown,
    ctx: ActionContext
  ) => Promise<unknown> | unknown;
  const approval = config.approval as ActionApprovalPolicy<unknown> | undefined;
  const permissions = config.permissions as
    | ActionPermissionSpec<unknown>
    | undefined;
  const idempotencyKey = config.idempotencyKey as
    | ActionIdempotencyKey<unknown>
    | undefined;

  return tool({
    description: config.description,
    metadata: {
      cfThinkAction: true,
      cfThinkActionApprovalConfigured:
        approval !== undefined && kind !== "durable-pause"
    },
    inputSchema: config.inputSchema as never,
    ...(approval !== undefined && kind !== "durable-pause"
      ? {
          needsApproval: async (
            input: unknown,
            options: {
              toolCallId: string;
              messages: ModelMessage[];
            }
          ) => {
            const ctx: ActionContext = {
              agent: host.agent,
              env: host.env(),
              requestId: host.requestId(),
              toolCallId: options.toolCallId,
              messages: options.messages,
              signal: new AbortController().signal,
              // No-op: approval/permission predicates must be pure and may
              // run twice (prompt + resume). Attachments belong to execute.
              attachReply: () => {}
            };
            if (host.isApproved(options.toolCallId)) {
              return true;
            }
            const authorization = await authorizeActionCall(host, {
              actionName: toolName,
              kind,
              input,
              ctx,
              permissions
            });
            if (!authorization.allowed) return false;
            const needsApproval =
              typeof approval === "function"
                ? await approval({ input, ctx })
                : approval;
            if (needsApproval) {
              host.recordApprovalDescriptor(options.toolCallId, {
                requestId: ctx.requestId,
                toolCallId: options.toolCallId,
                action: toolName,
                summary: config.approvalSummary ?? config.description,
                input,
                permissions: authorization.permissions,
                ...(config.approvalRisk !== undefined && {
                  risk: config.approvalRisk
                }),
                kind: "approval-gated"
              });
            }
            return needsApproval;
          }
        }
      : {}),
    execute: async (
      input: unknown,
      options: {
        toolCallId?: string;
        messages?: ModelMessage[];
        abortSignal?: AbortSignal;
      }
    ): Promise<unknown> => {
      const { signal, cleanup } = createActionAbortSignal(
        options.abortSignal,
        config.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS
      );
      const requestId = host.requestId();
      const actionContext: ActionContext = {
        agent: host.agent,
        env: host.env(),
        requestId,
        toolCallId: options.toolCallId ?? "",
        messages: options.messages ?? [],
        signal,
        attachReply: (attachment) =>
          host.recordReplyAttachment(requestId, attachment, toolName)
      };
      const abortError = () =>
        signal.reason instanceof Error
          ? signal.reason
          : new Error(signal.reason ? String(signal.reason) : "Action aborted");
      let onAbort: (() => void) | undefined;

      try {
        const authorization = await authorizeActionCall(host, {
          actionName: toolName,
          kind,
          input,
          ctx: actionContext,
          permissions
        });
        if (!authorization.allowed) {
          return actionAuthorizationErrorEnvelope(
            authorization.reason,
            authorization.permissions
          );
        }
        if (signal.aborted) throw abortError();
        const abortPromise = new Promise<never>((_, reject) => {
          onAbort = () => reject(abortError());
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const runAction = async () => {
          const output = await Promise.race([
            Promise.resolve(executeAction(input, actionContext)),
            abortPromise
          ]);
          return prepareActionOutputForModel(output);
        };

        if (kind === "durable-pause") {
          // The approval predicate gates whether to PARK (not whether an AI
          // SDK approval is needed). Absent → always park; a function may opt
          // a given input out of the human gate and run inline instead.
          const shouldPark =
            approval === undefined
              ? true
              : typeof approval === "function"
                ? await approval({
                    input,
                    ctx: actionContextWithoutReply(actionContext)
                  })
                : approval;
          if (!shouldPark) {
            return await host.runLedgered({
              toolName,
              idempotencyKey,
              input,
              ctx: actionContext,
              runAction
            });
          }
          return host.parkDurablePause({
            toolName,
            input,
            ctx: actionContext,
            summary: config.approvalSummary ?? config.description,
            permissions: authorization.permissions,
            risk: config.approvalRisk
          });
        }

        return await host.runLedgered({
          toolName,
          idempotencyKey,
          input,
          ctx: actionContext,
          runAction
        });
      } catch (error) {
        return actionErrorEnvelope(error);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
        cleanup();
      }
    }
  });
}
