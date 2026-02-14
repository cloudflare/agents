/**
 * Long-Running Agent — Durable Fibers Demo
 *
 * Demonstrates:
 * - experimental_spawnFiber() for fire-and-forget durable execution
 * - experimental_stashFiber() for checkpointing progress that survives eviction
 * - experimental_onFiberRecovered() for custom recovery after DO restart
 * - experimental_onFiberComplete() for handling completion
 * - experimental_cancelFiber() for stopping a running fiber
 * - experimental_getFiber() for querying fiber state
 * - Real-time progress via broadcast() to connected clients
 *
 * No API keys needed — research steps are simulated with delays.
 */

import {
  Agent,
  callable,
  routeAgentRequest,
  type experimental_FiberContext,
  type experimental_FiberRecoveryContext,
  type experimental_FiberCompleteContext,
  type experimental_FiberState
} from "agents";

// ── Types shared with the client ──────────────────────────────────────

export type ResearchStep = {
  name: string;
  result: string;
  completedAt: number;
};

export type ResearchPayload = {
  topic: string;
  steps: string[];
};

export type ResearchSnapshot = {
  topic: string;
  completedSteps: ResearchStep[];
  currentStep: string;
  totalSteps: number;
};

export type AgentState = {
  activeFiberId: string | null;
};

export type ProgressMessage =
  | {
      type: "research:started";
      fiberId: string;
      topic: string;
      steps: string[];
    }
  | {
      type: "research:step";
      fiberId: string;
      step: string;
      stepIndex: number;
      totalSteps: number;
      result: string;
    }
  | {
      type: "research:complete";
      fiberId: string;
      results: ResearchStep[];
    }
  | {
      type: "research:recovered";
      fiberId: string;
      skippedSteps: number;
      remainingSteps: number;
    }
  | {
      type: "research:failed";
      fiberId: string;
      error: string;
    }
  | {
      type: "research:cancelled";
      fiberId: string;
    };

// ── Simulated research work ───────────────────────────────────────────

const RESEARCH_FINDINGS: Record<string, string[]> = {
  default: [
    "Found 47 relevant papers from the last 5 years.",
    "Identified 3 major competing approaches in the literature.",
    "Cross-referenced citations reveal a key insight connecting two subfields.",
    "Statistical meta-analysis shows a strong effect size (d=0.82).",
    "Synthesized findings into a coherent narrative with 5 key takeaways."
  ]
};

function getFindings(topic: string): string[] {
  return RESEARCH_FINDINGS[topic.toLowerCase()] || RESEARCH_FINDINGS.default;
}

// ── The Agent ─────────────────────────────────────────────────────────

export class ResearchAgent extends Agent<Env, AgentState> {
  // Enable debug logging for fiber lifecycle
  static override options = { hibernate: true, experimental_debugFibers: true };

  initialState: AgentState = { activeFiberId: null };

  // ── Research fiber method ───────────────────────────────────────

  /**
   * The actual research work. Runs as a fiber — survives eviction.
   * Each step is checkpointed via experimental_stashFiber().
   */
  async doResearch(
    payload: ResearchPayload,
    fiberCtx: experimental_FiberContext
  ): Promise<{ results: ResearchStep[] }> {
    const { topic, steps } = payload;
    const findings = getFindings(topic);

    // On retry, resume from the last checkpoint
    const snapshot = fiberCtx.snapshot as ResearchSnapshot | null;
    const completedSteps = snapshot?.completedSteps ?? [];
    const startIndex = completedSteps.length;

    if (startIndex > 0) {
      this.broadcast(
        JSON.stringify({
          type: "research:recovered",
          fiberId: fiberCtx.id,
          skippedSteps: startIndex,
          remainingSteps: steps.length - startIndex
        } satisfies ProgressMessage)
      );
    }

    for (let i = startIndex; i < steps.length; i++) {
      const step = steps[i];

      // Simulate research work (1-2 seconds per step)
      const duration = 1000 + Math.random() * 1000;
      await new Promise((resolve) => setTimeout(resolve, duration));

      const result =
        findings[i % findings.length] || `Completed analysis for "${step}".`;

      const stepResult: ResearchStep = {
        name: step,
        result,
        completedAt: Date.now()
      };

      completedSteps.push(stepResult);

      // Checkpoint — this data survives eviction
      this.experimental_stashFiber({
        topic,
        completedSteps: [...completedSteps],
        currentStep: step,
        totalSteps: steps.length
      } satisfies ResearchSnapshot);

      // Broadcast progress to connected clients
      this.broadcast(
        JSON.stringify({
          type: "research:step",
          fiberId: fiberCtx.id,
          step,
          stepIndex: i,
          totalSteps: steps.length,
          result
        } satisfies ProgressMessage)
      );
    }

    return { results: completedSteps };
  }

  // ── Lifecycle hooks ─────────────────────────────────────────────

  override experimental_onFiberComplete(
    ctx: experimental_FiberCompleteContext
  ) {
    const results = (ctx.result as { results: ResearchStep[] })?.results;

    this.broadcast(
      JSON.stringify({
        type: "research:complete",
        fiberId: ctx.id,
        results: results ?? []
      } satisfies ProgressMessage)
    );

    this.setState({ activeFiberId: null });
  }

  override experimental_onFiberRecovered(
    ctx: experimental_FiberRecoveryContext
  ) {
    // Default behavior: restart the fiber.
    // The doResearch method checks fiberCtx.snapshot to skip completed steps.
    this.experimental_restartFiber(ctx.id);
  }

  // ── Callable methods (client-facing API) ────────────────────────

  @callable()
  startResearch(topic: string): {
    fiberId: string;
    steps: string[];
  } {
    // Define the research steps
    const steps = [
      "Literature Review",
      "Data Collection",
      "Analysis",
      "Cross-referencing",
      "Synthesis"
    ];

    const fiberId = this.experimental_spawnFiber("doResearch", {
      topic,
      steps
    } satisfies ResearchPayload);

    this.setState({ activeFiberId: fiberId });

    this.broadcast(
      JSON.stringify({
        type: "research:started",
        fiberId,
        topic,
        steps
      } satisfies ProgressMessage)
    );

    return { fiberId, steps };
  }

  @callable()
  cancelResearch(): boolean {
    const { activeFiberId } = this.state;
    if (!activeFiberId) return false;

    const cancelled = this.experimental_cancelFiber(activeFiberId);
    if (cancelled) {
      this.setState({ activeFiberId: null });
      this.broadcast(
        JSON.stringify({
          type: "research:cancelled",
          fiberId: activeFiberId
        } satisfies ProgressMessage)
      );
    }
    return cancelled;
  }

  @callable()
  getResearchStatus(): experimental_FiberState | null {
    const { activeFiberId } = this.state;
    if (!activeFiberId) return null;
    return this.experimental_getFiber(activeFiberId);
  }

  /**
   * Simulate a full DO eviction + recovery cycle for demo purposes.
   *
   * In a real eviction, the runtime kills the DO process. We can't
   * kill a running async function from JavaScript. So this method:
   * 1. Cancels the fiber (stops it cooperatively via experimental_cancelFiber)
   * 2. Resets the fiber status to 'running' (mimicking what SQLite
   *    looks like after a real eviction — process killed mid-execution)
   * 3. Removes from in-memory tracking
   * 4. Triggers the alarm handler, which detects the interrupted fiber
   *    and calls experimental_onFiberRecovered → experimental_restartFiber → resumes from checkpoint
   *
   * In production, steps 2-4 happen automatically: the process dies,
   * SQLite keeps 'running' status, and the heartbeat alarm fires on restart.
   */
  @callable()
  async simulateKillAndRecover(): Promise<boolean> {
    const { activeFiberId } = this.state;
    if (!activeFiberId) return false;

    // Step 1: Cancel the fiber (stops the running doResearch)
    this.experimental_cancelFiber(activeFiberId);

    // Step 2: Reset to 'running' — as if the process was killed
    // (experimental_cancelFiber set it to 'cancelled', but real eviction leaves it as 'running')
    const now = Date.now();
    this.sql`
      UPDATE cf_agents_fibers
      SET status = 'running', updated_at = ${now}
      WHERE id = ${activeFiberId}
    `;

    // Step 3: Trigger alarm → recovery detects interrupted fiber → restarts
    // (experimental_cancelFiber already cleared in-memory tracking)
    await this.alarm();

    return true;
  }
}

// ── Request handler ───────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
