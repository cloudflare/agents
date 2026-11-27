/**
 * ThinkHarness's own parts, as the first two extensions it loads: the
 * session context's tools, then its options (`tools`, `system` and the
 * hooks that take and return data).
 *
 * `model`, `onChunk`, `toolApproval` and `beforeTurn` stay options the
 * harness calls itself: they hand over live objects (a model, every
 * streamed chunk, a configuration that may hold a model).
 *
 * @internal Not exported from any entry point.
 */
import type { ToolSet } from "ai";
import type { Context } from "../../../context/context";
import type {
  PerSession,
  ThinkHarnessHooks,
  ThinkHarnessOptions,
  ThinkSessionId
} from "../types";
import type { ExtensionTool, ThinkExtension, ToolDraft } from "./types";

/**
 * A per-session option's value for `session`.
 *
 * @internal
 */
export async function resolve<T>(
  value: PerSession<T> | undefined,
  session: ThinkSessionId
): Promise<T | undefined> {
  if (typeof value === "function") {
    // SAFETY: PerSession<T> is T or a function of the session context, and
    // no T resolved here (a system prompt, a tool set) is a function, so a
    // function here is the per-session form.
    const compute = value as (context: {
      session: ThinkSessionId;
    }) => T | Promise<T>;
    return compute({ session });
  }
  return value;
}

function setAll(draft: ToolDraft, tools: ToolSet | undefined): void {
  for (const [name, tool] of Object.entries(tools ?? {})) {
    // SAFETY: a tool set's tools are AI SDK tools; `recovery` is optional.
    draft.set(name, tool as ExtensionTool);
  }
}

/**
 * The session context's tools (`set_context`, `search_context`). Loaded
 * first, so a tool from the options with the same name replaces one.
 *
 * @internal
 */
export function contextExtension(
  context: (session: ThinkSessionId) => Context | undefined
): ThinkExtension {
  return (ctx) => {
    ctx.tools.transform(async (tools, { session }) =>
      setAll(tools, await context(session)?.tools())
    );
  };
}

/** @internal */
export function optionsExtension(
  options: Pick<ThinkHarnessOptions, "tools" | "system" | "hooks">
): ThinkExtension {
  return (ctx) => {
    ctx.tools.transform(async (tools, { session }) =>
      setAll(tools, await resolve(options.tools, session))
    );
    ctx.prompt.transform(async (prompt, { session }) => {
      const text = await resolve(options.system, session);
      if (text !== undefined) prompt.set("system", { text });
    });
    // Each is called as a method of the hooks object, as the harness
    // called them before, so a hook that uses `this` still sees it.
    const hooks: ThinkHarnessHooks = options.hooks ?? {};
    if (hooks.beforeToolCall) {
      ctx.on("beforeToolCall", (call) => hooks.beforeToolCall?.(call));
    }
    if (hooks.afterToolCall) {
      ctx.on("afterToolCall", (result) => hooks.afterToolCall?.(result));
    }
    if (hooks.onStepFinish) {
      ctx.on("onStepFinish", (step) => hooks.onStepFinish?.(step));
    }
    if (hooks.onTurnEnd) {
      ctx.on("onTurnEnd", (end) => hooks.onTurnEnd?.(end));
    }
    if (hooks.onError) {
      ctx.on("onError", ({ error, ...context }) =>
        hooks.onError?.(error, context)
      );
    }
    if (hooks.classifyError) {
      ctx.on("classifyError", ({ error, session, operationId }) =>
        hooks.classifyError?.(
          error,
          session !== undefined && operationId !== undefined
            ? { session, operationId }
            : undefined
        )
      );
    }
    if (hooks.onRecovery) {
      ctx.on("onRecovery", (recovery) => hooks.onRecovery?.(recovery));
    }
  };
}
