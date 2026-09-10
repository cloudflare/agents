import type {
  AgentMessage,
  Entry,
  HarnessEvent
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionRunner } from "../../../vendor/pi-coding-agent-src/core/extensions/runner.ts";
import type { ExtensionEvent } from "../../../vendor/pi-coding-agent-src/core/extensions/types.ts";
import type { SessionEntry } from "../../../vendor/pi-coding-agent-src/core/session-manager.ts";
import { projectSessionEntry } from "./session-view";
import type {
  ExtensionLaneState,
  ExtensionLaneStates,
  PiExtensionErrorReporter
} from "./state";

/** Where one run's transcript stood when it started. */
type RunMark = {
  /** Index the run's own entries begin at, in the lane's entry list. */
  readonly from: number;
  /** Tip when the run started, which survives entries being re-read. */
  readonly tipId: string | null;
};

/**
 * The messages one run added, as `agent_end` reports them.
 *
 * The mark's tip is preferred over its index: entries are re-read between
 * the two events and a compaction can renumber them, while the tip entry
 * either is still on the branch or was compacted away — in which case the
 * recorded index is the only cursor left.
 */
export function messagesSince(
  entries: readonly Entry[],
  mark: RunMark | undefined
): AgentMessage[] {
  if (!mark) return [];
  const tipIndex =
    mark.tipId === null
      ? -1
      : entries.findIndex((entry) => entry.id === mark.tipId);
  const from = tipIndex >= 0 ? tipIndex + 1 : mark.from;
  return entries
    .slice(from)
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

/**
 * The messages one run added, from the entry ids its own events carried.
 *
 * The mark alone is not enough. It is read on the queued refresh
 * `agent_start` performs, and a fast run — a stub provider answering in the
 * same microtask — commits its entries before that step ever runs, leaving
 * the mark pointing past them and `agent_end` reporting nothing. The ids
 * come off the harness events themselves, recorded synchronously as they are
 * dispatched, so they describe the run whatever order the queue settles in.
 *
 * The mark stays as the fallback for a run whose events carried no ids at
 * all — a recovered run whose entries were committed in a dead isolate.
 */
export function runMessages(
  entries: readonly Entry[],
  entryIds: ReadonlySet<string> | undefined,
  mark: RunMark | undefined
): AgentMessage[] {
  if (entryIds === undefined || entryIds.size === 0) {
    return messagesSince(entries, mark);
  }
  return entries
    .filter((entry) => entryIds.has(entry.id))
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

/**
 * Project the compaction entry a `compaction_end` names, as pi's own
 * `session_compact` event carries it. Absent when the entry is no longer on
 * the lane's branch — a fabricated stand-in would tell an extension a
 * summary and a token count nobody produced.
 */
export function compactionEntry(
  entries: readonly Entry[],
  entryId: string
): Extract<SessionEntry, { type: "compaction" }> | undefined {
  const entry = entries.find(
    (candidate) => candidate.id === entryId && candidate.type === "compaction"
  );
  if (entry === undefined) return undefined;
  const projected = projectSessionEntry(entry, entries);
  return projected.type === "compaction" ? projected : undefined;
}

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
  /** Re-read one lane into its cached read model before handlers run. */
  readonly refresh: (lane: string) => Promise<void>;
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
  readonly #runMarks = new Map<string, RunMark>();
  /**
   * Entry ids each in-flight run has committed, collected at dispatch time.
   *
   * Dispatch is synchronous and emission is not, so this is the only view of
   * a run's boundary that cannot arrive after the run has already written.
   */
  readonly #runEntryIds = new Map<string, Set<string>>();
  readonly #turnLanes = new Map<string, string>();
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

  /**
   * The lane one in-flight turn belongs to, from the `turn_start` the
   * harness dispatched for it.
   *
   * This is the best the runtime can do unaided: it covers every tool call
   * of a live turn, and nothing of a call recovered after an eviction,
   * whose turn started in a dead isolate. A harness that can map an
   * invocation durably supplies `laneForInvocation` instead.
   */
  laneForTurn(turnId: string): string | undefined {
    return this.#turnLanes.get(turnId);
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
    this.#recordRunEntry(event, state);
    switch (event.type) {
      case "run_start": {
        this.#turnIndex.set(event.runId, 0);
        state.runId = event.runId;
        const runId = event.runId;
        this.#runEntryIds.set(runId, new Set());
        // Where the transcript stood, read after the refresh this step does,
        // so `agent_end` can report exactly what the run added.
        this.#emitFrom(lane, "agent_start", (current) => {
          this.#runMarks.set(runId, {
            from: current.entries.length,
            tipId: current.tipId
          });
          return { type: "agent_start" };
        });
        return;
      }
      case "run_end": {
        this.#turnIndex.delete(event.runId);
        state.runId = undefined;
        state.systemPromptOverride = undefined;
        const runId = event.runId;
        // Read here, not in the emit below: the ids are the run's own, and
        // `run_end` is the last event that can add to them.
        const entryIds = this.#runEntryIds.get(runId);
        this.#runEntryIds.delete(runId);
        this.#emitFrom(lane, "agent_end", (current) => {
          const mark = this.#runMarks.get(runId);
          this.#runMarks.delete(runId);
          return {
            type: "agent_end",
            messages: runMessages(current.entries, entryIds, mark)
          };
        });
        this.#emit(lane, { type: "agent_settled" });
        return;
      }
      case "turn_start": {
        const index = this.#turnIndex.get(event.runId) ?? 0;
        this.#turnIndex.set(event.runId, index + 1);
        // Recorded synchronously, before the turn's tool calls execute: a
        // tool invocation names its turn but not its lane.
        this.#turnLanes.set(event.turnId, lane);
        this.#emit(lane, {
          type: "turn_start",
          turnIndex: index,
          timestamp: Date.now()
        });
        return;
      }
      case "turn_end":
        // Tool calls settle before the turn does, so nothing still needs the
        // mapping once it ends.
        this.#turnLanes.delete(event.turnId);
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
          const entryId = event.entryId;
          const reason = event.reason;
          this.#emitFrom(lane, "session_compact", (current) => {
            const entry = compactionEntry(current.entries, entryId);
            if (entry === undefined) {
              // Nothing here knows the summary or the token count, and an
              // invented pair reads to an extension exactly like a real one.
              throw new Error(
                `compaction entry ${entryId} is not on lane ${lane}`
              );
            }
            return {
              type: "session_compact",
              compactionEntry: entry,
              fromExtension: false,
              reason,
              willRetry: false
            };
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

  /**
   * Note any entry id one harness event carries against the run that is open
   * on its lane.
   *
   * `entry_added` names every entry the run commits, and `message_end` and
   * `compaction_end` name theirs; `state.runId` supplies the run for the
   * events that do not carry one. Recording is synchronous with dispatch, so
   * a run that finishes before the emit queue drains still has its boundary.
   */
  #recordRunEntry(event: HarnessEvent, state: ExtensionLaneState): void {
    const runId =
      "runId" in event && typeof event.runId === "string"
        ? event.runId
        : state.runId;
    if (runId === undefined) return;
    const ids = this.#runEntryIds.get(runId);
    if (ids === undefined) return;
    if (event.type === "entry_added") {
      ids.add(event.entry.id);
      return;
    }
    if ("entryId" in event && typeof event.entryId === "string") {
      ids.add(event.entryId);
    }
  }

  #emit(lane: string, event: ExtensionEvent): void {
    this.#emitFrom(lane, event.type, () => event);
  }

  /**
   * Emit one event whose payload is read off the lane, after the refresh
   * this step performs. Everything derived from the transcript is built
   * here rather than at dispatch, where the lane read model is one event
   * behind.
   */
  #emitFrom(
    lane: string,
    source: string,
    build: (state: ExtensionLaneState) => ExtensionEvent
  ): void {
    this.#run(lane, source, async (state) => {
      // SAFETY: notification events carry no result; the runner's emit union
      // is wider than the notification subset built here.
      await this.#runner.emit(build(state) as never);
    });
  }

  #run(
    lane: string,
    source: string,
    work: (state: ExtensionLaneState) => Promise<void>
  ): void {
    this.#chain = this.#chain.then(async () => {
      try {
        // Notification handlers call the synchronous `pi.*` actions, which
        // resolve against the current lane and read the cached read model,
        // so this step owns both for as long as it runs.
        await this.#deps.states.withLane(lane, async (state) => {
          await this.#refresh(lane, source);
          await work(state);
        });
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

  /**
   * Refresh one lane's read model, tolerating a lane that cannot be read
   * yet. A stale read model is a worse handler experience than a fresh one,
   * but a failure here is not the handler's failure, so it is not reported
   * as one; the handler still runs.
   */
  async #refresh(lane: string, source: string): Promise<void> {
    try {
      await this.#deps.refresh(lane);
    } catch (error) {
      console.warn(
        `pi extensions: could not refresh lane ${lane} before ${source}`,
        error
      );
    }
  }
}
