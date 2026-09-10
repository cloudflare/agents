import type {
  AgentMessage,
  Context,
  HookName,
  Hooks,
  SettledAssistantMessage
} from "@earendil-works/pi-agent-core";
import type {
  ImageContent,
  ProviderHeaders,
  TextContent
} from "@earendil-works/pi-ai";
import type { ExtensionRunner } from "../../../vendor/pi-coding-agent-src/core/extensions/runner.ts";
import type {
  BeforeAgentStartEventResult,
  SessionBeforeCompactResult,
  SessionBeforeTreeResult,
  ToolCallEvent,
  ToolResultEvent
} from "../../../vendor/pi-coding-agent-src/core/extensions/types.ts";
import { projectSessionEntry } from "./session-view";
import type {
  ExtensionLaneState,
  ExtensionLaneStates,
  PiExtensionErrorReporter
} from "./state";

/** Id every hook the extension runtime installs is registered under. */
export const EXTENSION_HOOK_ID = "pi-extensions";

/** What the hook adapter needs from the runtime. */
export type ExtensionHookDeps = {
  readonly states: ExtensionLaneStates;
  readonly cwd: string;
  /** Re-read one lane into its cached read model before handlers run. */
  readonly refresh: (lane: string) => Promise<void>;
  /**
   * The system prompt `before_agent_start` should see.
   *
   * `before_run` fires before the harness assembles the request, so the
   * lane's cached prompt is the previous run's — and empty on the first
   * one. The runtime resolves the current prompt instead.
   */
  readonly systemPrompt: (
    lane: string,
    state: ExtensionLaneState
  ) => Promise<string>;
  readonly report: PiExtensionErrorReporter;
};

function promptText(messages: readonly AgentMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part): part is TextContent => part.type === "text")
            .map((part) => part.text)
            .join("")
    )
    .join("\n");
}

function promptImages(
  messages: readonly AgentMessage[]
): ImageContent[] | undefined {
  const images = messages.flatMap((message) =>
    message.role === "user" && typeof message.content !== "string"
      ? message.content.filter(
          (part): part is ImageContent => part.type === "image"
        )
      : []
  );
  return images.length > 0 ? images : undefined;
}

function customMessage(
  message: NonNullable<BeforeAgentStartEventResult["message"]>
): AgentMessage {
  return {
    role: "custom",
    customType: message.customType,
    content: message.content,
    display: message.display,
    ...(message.details === undefined ? {} : { details: message.details }),
    timestamp: Date.now()
  };
}

/**
 * Bridge pi's extension events onto the harness's hook registry.
 *
 * Every hook is registered under one id so the whole surface can be removed
 * with the harness it belongs to. Nine of the harness's eleven hooks are
 * used; `before_drive` and `before_run_end` have no extension counterpart.
 *
 * A handler that throws must not take the operation down, and only some of
 * the runner's emit methods catch for themselves, so every bridge here
 * catches and reports a `handler_error`. All but one then return the
 * unmodified value; `before_tool` blocks the call instead, because a
 * permission check that failed to run is not a permission check that
 * passed.
 */
export function bindExtensionHooks(
  hooks: Hooks,
  runner: ExtensionRunner,
  deps: ExtensionHookDeps
): () => void {
  const { states, report } = deps;
  const disposers: Array<() => void> = [];

  const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const fail = (hook: HookName, lane: string, error: unknown): void => {
    report({
      lane,
      kind: "hook",
      source: hook,
      message: message(error),
      ...(error instanceof Error && error.stack !== undefined
        ? { stack: error.stack }
        : {})
    });
  };

  /**
   * Run one hook body with its lane current and its read model fresh.
   *
   * The lane is restored afterwards: hooks on two lanes are each other's
   * only contenders for the synchronous `pi.*` surface, and leaving the
   * second lane current would send the first lane's later writes to it.
   *
   * The invocation's own context supplies the scope's signal, so a handler
   * that reads `ctx.signal` watches the operation it is running inside
   * rather than something that never aborts.
   */
  const onLane = <T>(
    lane: string,
    runId: string,
    context: Context,
    run: (state: ExtensionLaneState) => Promise<T>
  ): Promise<T> =>
    states.withLane(
      lane,
      async (state) => {
        await deps.refresh(lane);
        return run(state);
      },
      { runId, ...(context.abortSignal ? { signal: context.abortSignal } : {}) }
    );

  const guard = async <T>(
    hook: HookName,
    lane: string,
    fallback: T,
    runId: string,
    context: Context,
    run: (state: ExtensionLaneState) => Promise<T>
  ): Promise<T> => {
    try {
      return await onLane(lane, runId, context, run);
    } catch (error) {
      fail(hook, lane, error);
      return fallback;
    }
  };

  disposers.push(
    hooks.on(
      "before_run",
      (event, context) =>
        guard(
          "before_run",
          event.lane,
          undefined,
          event.runId,
          context,
          async (state) => {
            const result = await runner.emitBeforeAgentStart(
              promptText(event.prompt),
              promptImages(event.prompt),
              await deps.systemPrompt(event.lane, state),
              { cwd: deps.cwd }
            );
            if (!result) return undefined;
            // The system prompt is only known at transform_context, so an
            // override is stashed here and applied there.
            if (result.systemPrompt !== undefined) {
              state.systemPromptOverride = result.systemPrompt;
            }
            return result.messages
              ? { messages: result.messages.map(customMessage) }
              : undefined;
          }
        ),
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "transform_context",
      (event, context) =>
        guard(
          "transform_context",
          event.lane,
          undefined,
          event.runId,
          context,
          async (state) => {
            state.systemPrompt = event.systemPrompt;
            const messages = await runner.emitContext([...event.messages]);
            const systemPrompt = state.systemPromptOverride;
            return {
              messages,
              ...(systemPrompt === undefined ? {} : { systemPrompt })
            };
          }
        ),
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "before_request",
      (event, context) =>
        guard(
          "before_request",
          event.lane,
          undefined,
          event.runId,
          context,
          async () => {
            const before = event.streamOptions.headers ?? {};
            const headers: ProviderHeaders = { ...before };
            await runner.emitBeforeProviderHeaders(headers);
            // Handlers mutate in place; pi-ai deletes a header with null,
            // the harness patch deletes it with undefined.
            const patch: Record<string, string | undefined> = {};
            for (const key of Object.keys(before)) patch[key] = undefined;
            for (const [key, value] of Object.entries(headers)) {
              patch[key] = value === null ? undefined : value;
            }
            return { streamOptions: { headers: patch } };
          }
        ),
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "before_payload",
      (event, context) =>
        guard(
          "before_payload",
          event.lane,
          undefined,
          event.runId,
          context,
          async () => {
            const payload = await runner.emitBeforeProviderRequest(
              event.payload
            );
            return { payload };
          }
        ),
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "after_response",
      (event, context) =>
        guard(
          "after_response",
          event.lane,
          undefined,
          event.runId,
          context,
          async () => {
            await runner.emit({
              type: "after_provider_response",
              status: event.status ?? 0,
              headers: event.headers ?? {}
            });
            const message = await runner.emitMessageEnd({
              type: "message_end",
              message: event.message
            });
            return message !== undefined && message.role === "assistant"
              ? { message: message as SettledAssistantMessage }
              : undefined;
          }
        ),
      { id: EXTENSION_HOOK_ID }
    )
  );

  // `before_tool` is the one gate that fails closed. Every other bridge
  // returns the unmodified value when a handler throws, because the worst a
  // lost handler can do there is leave the run as pi would have run it
  // anyway. Here a lost handler is a permission check that never ran, so a
  // throw blocks the call with the failure as its reason — as
  // `hooks.beforeTool` does upstream — and is reported as well.
  disposers.push(
    hooks.on(
      "before_tool",
      async (event, context) => {
        try {
          return await onLane(event.lane, event.runId, context, async () => {
            const input = { ...event.args };
            const call = {
              type: "tool_call",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input
            } as unknown as ToolCallEvent;
            const result = await runner.emitToolCall(call);
            if (result?.block) {
              return {
                block: {
                  reason: result.reason ?? "Blocked by an extension",
                  ...(result.terminate === undefined
                    ? {}
                    : { terminate: result.terminate })
                }
              };
            }
            // Handlers patch arguments by mutating `event.input` in place.
            return { args: input };
          });
        } catch (error) {
          fail("before_tool", event.lane, error);
          return { block: { reason: message(error) } };
        }
      },
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "after_tool",
      (event, context) =>
        guard(
          "after_tool",
          event.lane,
          undefined,
          event.runId,
          context,
          async () => {
            const result = await runner.emitToolResult({
              type: "tool_result",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.args,
              content: event.content,
              details: event.details,
              isError: event.isError,
              ...(event.usage === undefined ? {} : { usage: event.usage })
            } as unknown as ToolResultEvent);
            if (!result) return undefined;
            return {
              ...(result.content === undefined
                ? {}
                : { content: result.content }),
              ...(result.details === undefined
                ? {}
                : { details: result.details as never }),
              ...(result.isError === undefined
                ? {}
                : { isError: result.isError }),
              ...(result.usage === undefined ? {} : { usage: result.usage })
            };
          }
        ),
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "before_compaction",
      (event, context) =>
        guard(
          "before_compaction",
          event.lane,
          undefined,
          event.runId,
          context,
          async (state) => {
            const result = (await runner.emit({
              type: "session_before_compact",
              preparation: event.preparation,
              branchEntries: state.entries.map(projectSessionEntry),
              ...(event.customInstructions === undefined
                ? {}
                : { customInstructions: event.customInstructions }),
              reason: event.reason,
              willRetry: false,
              // The compaction's own cancellation, not a stand-in: a handler
              // that summarizes with a provider call has to see the
              // operation go away.
              signal: context.abortSignal ?? new AbortController().signal
            })) as SessionBeforeCompactResult | undefined;
            if (result?.cancel) return { decline: true };
            if (!result?.compaction) return undefined;
            return {
              compaction: {
                summary: result.compaction.summary,
                tokensBefore: result.compaction.tokensBefore,
                retainedTail: event.preparation.retainedTail,
                ...(result.compaction.usage === undefined
                  ? {}
                  : { usage: result.compaction.usage }),
                ...(result.compaction.details === undefined
                  ? {}
                  : { details: result.compaction.details as never })
              }
            };
          }
        ),
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "before_navigation",
      (event, context) =>
        guard(
          "before_navigation",
          event.lane,
          undefined,
          event.runId,
          context,
          async (state) => {
            const result = (await runner.emit({
              type: "session_before_tree",
              preparation: {
                targetId: event.targetId,
                oldLeafId: state.tipId,
                // The harness prepares messages, not a branch walk.
                commonAncestorId: null,
                entriesToSummarize: [],
                userWantsSummary: true,
                ...(event.customInstructions === undefined
                  ? {}
                  : { customInstructions: event.customInstructions })
              },
              signal: context.abortSignal ?? new AbortController().signal
            })) as SessionBeforeTreeResult | undefined;
            if (result?.cancel) return { decline: true };
            if (!result?.summary) return undefined;
            return {
              summary: {
                summary: result.summary.summary,
                ...(result.summary.usage === undefined
                  ? {}
                  : { usage: result.summary.usage }),
                readFiles: [],
                modifiedFiles: []
              }
            };
          }
        ),
      { id: EXTENSION_HOOK_ID }
    )
  );

  return () => {
    for (const dispose of disposers) dispose();
    disposers.length = 0;
  };
}
