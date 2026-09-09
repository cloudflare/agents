import type {
  AgentMessage,
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
import type { ExtensionLaneStates, PiExtensionErrorReporter } from "./state";

/** Id every hook the extension runtime installs is registered under. */
export const EXTENSION_HOOK_ID = "pi-extensions";

/** What the hook adapter needs from the runtime. */
export type ExtensionHookDeps = {
  readonly states: ExtensionLaneStates;
  readonly cwd: string;
  /** Re-read one lane into its cached read model before handlers run. */
  readonly refresh: (lane: string) => Promise<void>;
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
 * catches, reports a `handler_error`, and returns the unmodified value.
 */
export function bindExtensionHooks(
  hooks: Hooks,
  runner: ExtensionRunner,
  deps: ExtensionHookDeps
): () => void {
  const { states, report } = deps;
  const disposers: Array<() => void> = [];

  const enter = async (
    lane: string,
    runId: string
  ): Promise<ReturnType<ExtensionLaneStates["enter"]>> => {
    const state = states.enter(lane, runId);
    await deps.refresh(lane);
    return state;
  };

  const guard = async <T>(
    hook: HookName,
    lane: string,
    fallback: T,
    run: () => Promise<T>
  ): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      report({
        lane,
        kind: "hook",
        source: hook,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack !== undefined
          ? { stack: error.stack }
          : {})
      });
      return fallback;
    }
  };

  disposers.push(
    hooks.on(
      "before_run",
      (event) =>
        guard("before_run", event.lane, undefined, async () => {
          const state = await enter(event.lane, event.runId);
          const result = await runner.emitBeforeAgentStart(
            promptText(event.prompt),
            promptImages(event.prompt),
            state.systemPrompt,
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
        }),
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "transform_context",
      (event) =>
        guard("transform_context", event.lane, undefined, async () => {
          const state = await enter(event.lane, event.runId);
          state.systemPrompt = event.systemPrompt;
          const messages = await runner.emitContext([...event.messages]);
          const systemPrompt = state.systemPromptOverride;
          return {
            messages,
            ...(systemPrompt === undefined ? {} : { systemPrompt })
          };
        }),
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "before_request",
      (event) =>
        guard("before_request", event.lane, undefined, async () => {
          await enter(event.lane, event.runId);
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
        }),
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "before_payload",
      (event) =>
        guard("before_payload", event.lane, undefined, async () => {
          await enter(event.lane, event.runId);
          const payload = await runner.emitBeforeProviderRequest(event.payload);
          return { payload };
        }),
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "after_response",
      (event) =>
        guard("after_response", event.lane, undefined, async () => {
          await enter(event.lane, event.runId);
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
        }),
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "before_tool",
      (event) =>
        guard("before_tool", event.lane, undefined, async () => {
          await enter(event.lane, event.runId);
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
        }),
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "after_tool",
      (event) =>
        guard("after_tool", event.lane, undefined, async () => {
          await enter(event.lane, event.runId);
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
        }),
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "before_compaction",
      (event) =>
        guard("before_compaction", event.lane, undefined, async () => {
          const state = await enter(event.lane, event.runId);
          const result = (await runner.emit({
            type: "session_before_compact",
            preparation: event.preparation,
            branchEntries: state.entries.map(projectSessionEntry),
            ...(event.customInstructions === undefined
              ? {}
              : { customInstructions: event.customInstructions }),
            reason: event.reason,
            willRetry: false,
            signal: new AbortController().signal
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
        }),
      { id: EXTENSION_HOOK_ID }
    )
  );

  disposers.push(
    hooks.on(
      "before_navigation",
      (event) =>
        guard("before_navigation", event.lane, undefined, async () => {
          const state = await enter(event.lane, event.runId);
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
            signal: new AbortController().signal
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
        }),
      { id: EXTENSION_HOOK_ID }
    )
  );

  return () => {
    for (const dispose of disposers) dispose();
    disposers.length = 0;
  };
}
