import {
  BACKGROUND_CONTEXT,
  type AgentLane
} from "@earendil-works/pi-agent-core";
import type {
  CompactOptions,
  ExtensionCommandContextActions,
  ExtensionContextActions
} from "../../../vendor/pi-coding-agent-src/core/extensions/types.ts";
import type { ExtensionLaneStates, PiExtensionErrorReporter } from "./state";

/** What the context actions need from the host. */
export type ExtensionContextActionDeps = {
  readonly states: ExtensionLaneStates;
  readonly cwd: string;
  readonly lane: (name: string) => Promise<AgentLane>;
  /** Durably submit a compaction on one lane. */
  readonly compact: (
    lane: string,
    options: CompactOptions | undefined
  ) => Promise<void>;
  /** Durably submit a tree navigation on one lane. */
  readonly navigate: (
    lane: string,
    targetId: string | null,
    options:
      | {
          summarize?: boolean;
          customInstructions?: string;
          replaceInstructions?: boolean;
          label?: string;
        }
      | undefined
  ) => Promise<void>;
  readonly report: PiExtensionErrorReporter;
};

function reportFailure(
  report: PiExtensionErrorReporter,
  lane: string,
  source: string,
  error: unknown
): void {
  report({
    lane,
    kind: "extension",
    source,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack !== undefined
      ? { stack: error.stack }
      : {})
  });
}

/**
 * The `ctx.*` values every extension event handler sees.
 *
 * Everything readable comes from the cached lane read model; everything that
 * acts is a durable lane call. `isProjectTrusted` is fixed true: a Durable
 * Object has no project directory to distrust, and pi's `project_trust`
 * handshake has no counterpart here.
 */
export function createExtensionContextActions(
  deps: ExtensionContextActionDeps
): ExtensionContextActions {
  const { states, report } = deps;
  return {
    getModel: () => states.current.model,
    // Model scoping is a terminal-cycling feature with nothing behind it here.
    getScopedModels: () => [],
    isIdle: () => !states.current.busy,
    isProjectTrusted: () => true,
    getSignal: () => states.current.signal,
    abort: () => {
      const state = states.current;
      const runId = state.runId;
      if (runId === undefined) return;
      void deps
        .lane(state.lane)
        .then((lane) => lane.requestAbort(runId, BACKGROUND_CONTEXT))
        .catch((error: unknown) => {
          reportFailure(report, state.lane, "abort", error);
        });
    },
    hasPendingMessages: () => states.current.queued > 0,
    // The Durable Object outlives any one extension; there is nothing to quit.
    shutdown: () => {},
    getContextUsage: () => states.current.contextUsage,
    compact: (options) => {
      const state = states.current;
      void deps.compact(state.lane, options).catch((error: unknown) => {
        reportFailure(report, state.lane, "compact", error);
        options?.onError?.(
          error instanceof Error ? error : new Error(String(error))
        );
      });
    },
    getSystemPrompt: () =>
      states.current.systemPromptOverride ?? states.current.systemPrompt,
    getSystemPromptOptions: () => ({ cwd: deps.cwd })
  };
}

/**
 * The extra `ctx.*` values a slash-command handler sees.
 *
 * Session replacement has no meaning for a harness whose session is the
 * Durable Object itself, so `newSession`, `fork`, `switchSession` and
 * `reload` decline rather than pretending to succeed. Navigation is real: it
 * becomes one durable navigation operation on the lane.
 */
export function createExtensionCommandContextActions(
  deps: ExtensionContextActionDeps
): ExtensionCommandContextActions {
  const { states, report } = deps;
  return {
    waitForIdle: async () => {
      const state = states.current;
      const lane = await deps.lane(state.lane);
      await lane.waitForIdle(BACKGROUND_CONTEXT);
    },
    newSession: async () => ({ cancelled: true }),
    fork: async () => ({ cancelled: true }),
    navigateTree: async (targetId, options) => {
      const state = states.current;
      try {
        await deps.navigate(state.lane, targetId, options);
        return { cancelled: false };
      } catch (error) {
        reportFailure(report, state.lane, "navigateTree", error);
        return { cancelled: true };
      }
    },
    switchSession: async () => ({ cancelled: true }),
    reload: async () => {}
  };
}
