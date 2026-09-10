/**
 * The host bindings the agent-tool parent engine needs but does not own:
 * child-facet resolution, client broadcast, the user-facing lifecycle hooks,
 * and the two execution seams (`runDetachedDelivery`, `onStreamProgress`)
 * chat hosts override. Supplied through a composition-root aperture, the same
 * shape as `setSchedulerCallbackResolver`, so the capability's constructor
 * stays policy-only.
 */

import type {
  AgentToolLifecycleResult,
  AgentToolMilestone,
  AgentToolProgressSnapshot,
  AgentToolRunInfo
} from "../agent-tool-types";
import type { AgentTools } from "./agent-tools";

/** Host bindings for one installed {@link AgentTools} capability. */
export type AgentToolsHost = {
  /**
   * The host's live concurrency cap, when it exposes one of its own (Agent's
   * `maxConcurrentAgentTools` field, which a subclass may reassign at any
   * time). Omitted hosts fall back to the capability's `maxConcurrent` option.
   */
  readonly maxConcurrent?: () => number;
  /**
   * The host's live DETACHED concurrency cap, when it exposes one of its own
   * (Agent's `maxConcurrentDetachedAgentTools` field). Omitted hosts fall back
   * to the capability's `maxConcurrentDetached` option.
   */
  readonly maxConcurrentDetached?: () => number;
  /**
   * Resolve (creating or waking) the child facet running `runId` for an agent
   * class name, as an object implementing the agent-tool child adapter.
   */
  readonly resolveChild: (agentType: string, runId: string) => Promise<unknown>;
  /** Delete the child facet that ran `runId`, including its storage. */
  readonly deleteChild: (agentType: string, runId: string) => Promise<void>;
  /** Send one serialized frame to every connected client. */
  readonly broadcast: (frame: string) => void;
  /** User hook fired once a run row exists and the child is being started. */
  readonly onAgentToolStart: (run: AgentToolRunInfo) => Promise<void>;
  /** User hook fired once per run when it reaches a terminal result. */
  readonly onAgentToolFinish: (
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ) => Promise<void>;
  /** User hook fired for every forwarded `reportProgress` signal. */
  readonly onProgress: (
    run: AgentToolRunInfo,
    progress: AgentToolProgressSnapshot
  ) => Promise<void>;
  /** The host's error sink for best-effort background work. */
  readonly onError: (error: unknown) => Promise<void>;
  /**
   * Look up a durable callback by method name — `detached.onFinish` and the
   * chat-layer notify hook. Returns a host-bound function, or `undefined`
   * when the name does not resolve to one. Used both to validate at dispatch
   * time and to invoke at delivery time.
   */
  readonly resolveCallback: (
    name: string
  ) => ((...args: never[]) => unknown) | undefined;
  /**
   * Run a detached terminal delivery in an appropriate execution context.
   * Chat hosts additionally serialize it against their turn queue when
   * `serialize` is set.
   */
  readonly runDetachedDelivery: (
    invoke: () => Promise<void>,
    options?: { serialize?: boolean }
  ) => Promise<void>;
  /**
   * Credit the host's own recovery progress after child output was forwarded.
   * A no-op for hosts without a recovery budget.
   */
  readonly onStreamProgress: () => Promise<void>;
  /**
   * Deliver one `detached: { onMilestones }` notification. Called from both
   * the warm tail and the backbone reconcile, so it MUST be idempotent.
   */
  readonly deliverDetachedMilestone: (
    run: AgentToolRunInfo,
    milestone: AgentToolMilestone,
    mode: "react" | "narrate"
  ) => Promise<void>;
  /** Extend the host invocation's lifetime over background work. */
  readonly waitUntil: (work: Promise<unknown>) => void;
};

const agentToolsHosts = new WeakMap<object, AgentToolsHost>();

/**
 * @internal Supply the host bindings for one {@link AgentTools} instance.
 * Agent calls this from its constructor with delegates that route back
 * through its own overridable methods, so subclass overrides keep working.
 */
export function setAgentToolsHost(
  capability: AgentTools,
  host: AgentToolsHost
): void {
  agentToolsHosts.set(capability, host);
}

/**
 * @internal Read the host bindings installed for one capability. Paired with
 * {@link setAgentToolsHost} so a host (or a test) can re-install a WRAPPED port
 * — scripting `resolveChild`, observing `broadcast` — without the capability
 * exposing its internals.
 */
export function getAgentToolsHost(
  capability: AgentTools
): AgentToolsHost | undefined {
  return agentToolsHosts.get(capability);
}
