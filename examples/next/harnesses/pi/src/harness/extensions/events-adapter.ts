import type { HarnessEvent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionRunner } from "../../../vendor/pi-coding-agent-src/core/extensions/runner.ts";
import type { ExtensionEvent } from "../../../vendor/pi-coding-agent-src/core/extensions/types.ts";
import type { ExtensionLaneStates, PiExtensionErrorReporter } from "./state";

/** What the event adapter needs from the runtime. */
export type ExtensionEventDeps = {
  readonly states: ExtensionLaneStates;
  readonly cwd: string;
  /** Resolve one catalog model for the model-selection notification. */
  readonly resolveModel: (
    provider: string,
    modelId: string
  ) => Model<Api> | undefined;
  readonly report: PiExtensionErrorReporter;
  /** Receive the resource paths extensions asked pi to load at startup. */
  readonly resources?: (discovered: {
    readonly skillPaths: ReadonlyArray<{ path: string; extensionPath: string }>;
    readonly promptPaths: ReadonlyArray<{
      path: string;
      extensionPath: string;
    }>;
    readonly themePaths: ReadonlyArray<{ path: string; extensionPath: string }>;
  }) => void;
};

/**
 * Forward the harness's event stream to extensions as pi's own notifications.
 *
 * These are one-way: the runner's `emit` has no result for notification
 * events, so nothing here can change the run. The interception points are the
 * hooks. Emission is asynchronous while `#dispatchEvent` is synchronous, so
 * emits are appended to one chain: extensions observe events in the order the
 * harness produced them, and a handler that throws becomes a `handler_error`
 * rather than an unhandled rejection.
 *
 * Unsupported, by design: `project_trust` (no project directory to trust),
 * `user_bash` (no interactive `!` prefix), and
 * `session_before_switch` / `session_before_fork` (a Durable Object holds one
 * session for its lifetime).
 */
export class ExtensionEventAdapter {
  readonly #runner: ExtensionRunner;
  readonly #deps: ExtensionEventDeps;
  readonly #turnIndex = new Map<string, number>();
  readonly #toolArgs = new Map<string, unknown>();
  #chain: Promise<void> = Promise.resolve();

  constructor(runner: ExtensionRunner, deps: ExtensionEventDeps) {
    this.#runner = runner;
    this.#deps = deps;
  }

  /** Announce the session to extensions and collect their resource paths. */
  start(): void {
    this.#emit(this.#deps.states.defaultLane, {
      type: "session_start",
      reason: "startup"
    });
    this.#run(this.#deps.states.defaultLane, "resources_discover", async () => {
      const discovered = await this.#runner.emitResourcesDiscover(
        this.#deps.cwd,
        "startup"
      );
      this.#deps.resources?.(discovered);
    });
  }

  /** Tell extensions the runtime is going away, then drain the queue. */
  async stop(): Promise<void> {
    this.#emit(this.#deps.states.defaultLane, {
      type: "session_shutdown",
      reason: "quit"
    });
    await this.#chain;
  }

  /** Wait for every queued notification to settle. */
  async drain(): Promise<void> {
    await this.#chain;
  }

  /** Project one harness event onto pi's extension notifications. */
  dispatch(event: HarnessEvent): void {
    const lane =
      "lane" in event && typeof event.lane === "string"
        ? event.lane
        : this.#deps.states.defaultLane;
    const state = this.#deps.states.get(lane);
    switch (event.type) {
      case "run_start":
        this.#turnIndex.set(event.runId, 0);
        state.runId = event.runId;
        this.#emit(lane, { type: "agent_start" });
        return;
      case "run_end":
        this.#turnIndex.delete(event.runId);
        state.runId = undefined;
        state.systemPromptOverride = undefined;
        this.#emit(lane, { type: "agent_end", messages: [] });
        this.#emit(lane, { type: "agent_settled" });
        return;
      case "turn_start": {
        const index = this.#turnIndex.get(event.runId) ?? 0;
        this.#turnIndex.set(event.runId, index + 1);
        this.#emit(lane, {
          type: "turn_start",
          turnIndex: index,
          timestamp: Date.now()
        });
        return;
      }
      case "turn_end":
        this.#emit(lane, {
          type: "turn_end",
          turnIndex: Math.max(0, (this.#turnIndex.get(event.runId) ?? 1) - 1),
          message: event.message,
          toolResults: event.toolResults
        });
        return;
      case "message_start":
        this.#emit(lane, { type: "message_start", message: event.message });
        return;
      case "message_update":
        this.#emit(lane, {
          type: "message_update",
          message: event.message,
          assistantMessageEvent: event.event
        });
        return;
      case "message_end":
        // An assistant message reaches extensions through `after_response`,
        // where a handler can still replace it before pi commits it.
        if (event.message.role === "assistant") return;
        this.#emit(lane, { type: "message_end", message: event.message });
        return;
      case "tool_start":
        this.#toolArgs.set(event.toolCallId, event.args);
        this.#emit(lane, {
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args
        });
        return;
      case "tool_update":
        this.#emit(lane, {
          type: "tool_execution_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: this.#toolArgs.get(event.toolCallId),
          partialResult: event.partialResult
        });
        return;
      case "tool_end":
        this.#toolArgs.delete(event.toolCallId);
        this.#emit(lane, {
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError
        });
        return;
      case "config_update": {
        if (event.property === "model") {
          const previousModel = state.model;
          const model = this.#deps.resolveModel(
            event.value.provider,
            event.value.modelId
          );
          if (!model) return;
          state.model = model;
          this.#emit(lane, {
            type: "model_select",
            model,
            previousModel,
            source: "set"
          });
          return;
        }
        if (event.property === "thinkingLevel") {
          state.thinkingLevel = event.value;
          this.#emit(lane, {
            type: "thinking_level_select",
            level: event.value,
            previousLevel: event.previous
          });
        }
        return;
      }
      case "compaction_end":
        if (event.status === "completed") {
          this.#emit(lane, {
            type: "session_compact",
            compactionEntry: {
              type: "compaction",
              id: event.entryId,
              parentId: null,
              timestamp: new Date(event.endedAt).toISOString(),
              summary: "",
              firstKeptEntryId: event.entryId,
              tokensBefore: 0
            },
            fromExtension: false,
            reason: event.reason,
            willRetry: false
          });
          return;
        }
        this.#emit(lane, {
          type: "session_compact_failed",
          reason: event.reason,
          ...(event.status === "failed"
            ? { errorMessage: event.error.message }
            : {}),
          aborted: event.status === "aborted" || event.status === "declined",
          willRetry: false,
          fromExtension: false
        });
        return;
      case "navigation_end":
        if (event.status !== "completed") return;
        this.#emit(lane, {
          type: "session_tree",
          newLeafId: event.tipId,
          oldLeafId: event.fromTipId,
          fromExtension: false
        });
        return;
      case "value_update":
        if (event.value !== "session_name") return;
        state.sessionName = event.name;
        this.#emit(lane, { type: "session_info_changed", name: event.name });
        return;
      default:
        return;
    }
  }

  #emit(lane: string, event: ExtensionEvent): void {
    this.#run(lane, event.type, async () => {
      // SAFETY: notification events carry no result; the runner's emit union
      // is wider than the notification subset built here.
      await this.#runner.emit(event as never);
    });
  }

  #run(lane: string, source: string, work: () => Promise<void>): void {
    this.#chain = this.#chain.then(async () => {
      try {
        await work();
      } catch (error) {
        this.#deps.report({
          lane,
          kind: "event",
          source,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack !== undefined
            ? { stack: error.stack }
            : {})
        });
      }
    });
  }
}
