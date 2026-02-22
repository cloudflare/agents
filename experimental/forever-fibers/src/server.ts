/**
 * Long-Running Agent — Durable Fibers Demo
 *
 * Demonstrates:
 * - spawnFiber() for fire-and-forget durable execution
 * - stashFiber() for checkpointing progress that survives eviction
 * - onFiberRecovered() for custom recovery after DO restart
 * - onFiberComplete() for handling completion
 * - cancelFiber() for stopping a running fiber
 * - getFiber() for querying fiber state
 * - Real-time progress via broadcast() to connected clients
 *
 * No API keys needed — research steps are simulated with delays.
 */

import { Agent, callable, routeAgentRequest } from "agents";
import {
  withFibers,
  type FiberContext,
  type FiberRecoveryContext,
  type FiberCompleteContext,
  type FiberState
} from "agents/experimental/forever";

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

const FiberAgent = withFibers(Agent, { debugFibers: true });

export class ResearchAgent extends FiberAgent<Env, AgentState> {
  initialState: AgentState = { activeFiberId: null };

  // ── Research fiber method ───────────────────────────────────────

  async doResearch(
    payload: ResearchPayload,
    fiberCtx: FiberContext
  ): Promise<{ results: ResearchStep[] }> {
    const { topic, steps } = payload;
    const findings = getFindings(topic);

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

      this.stashFiber({
        topic,
        completedSteps: [...completedSteps],
        currentStep: step,
        totalSteps: steps.length
      } satisfies ResearchSnapshot);

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

  override onFiberComplete(ctx: FiberCompleteContext) {
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

  override onFiberRecovered(ctx: FiberRecoveryContext) {
    this.restartFiber(ctx.id);
  }

  // ── Callable methods (client-facing API) ────────────────────────

  @callable()
  startResearch(topic: string): {
    fiberId: string;
    steps: string[];
  } {
    const steps = [
      "Literature Review",
      "Data Collection",
      "Analysis",
      "Cross-referencing",
      "Synthesis"
    ];

    const fiberId = this.spawnFiber("doResearch", {
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

    const cancelled = this.cancelFiber(activeFiberId);
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
  getResearchStatus(): FiberState | null {
    const { activeFiberId } = this.state;
    if (!activeFiberId) return null;
    return this.getFiber(activeFiberId);
  }

  @callable()
  async simulateKillAndRecover(): Promise<boolean> {
    const { activeFiberId } = this.state;
    if (!activeFiberId) return false;

    this.cancelFiber(activeFiberId);

    const now = Date.now();
    this.sql`
      UPDATE cf_agents_fibers
      SET status = 'running', updated_at = ${now}
      WHERE id = ${activeFiberId}
    `;

    // (cancelFiber already cleared in-memory tracking)
    await this.checkFibers();

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
