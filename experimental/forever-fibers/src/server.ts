/**
 * Long-Running Agent — Durable Fibers Demo
 *
 * Demonstrates:
 * - runFiber() for durable long-running execution
 * - ctx.stash() for checkpointing progress that survives eviction
 * - _onFiberRecovered() for custom recovery after DO restart
 * - Real-time progress via broadcast() to connected clients
 *
 * No API keys needed — research steps are simulated with delays.
 */

import {
  Agent,
  callable,
  routeAgentRequest,
  type FiberRecoveryContext
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
      topic: string;
      steps: string[];
    }
  | {
      type: "research:step";
      step: string;
      stepIndex: number;
      totalSteps: number;
      result: string;
    }
  | {
      type: "research:complete";
      results: ResearchStep[];
    }
  | {
      type: "research:recovered";
      skippedSteps: number;
      remainingSteps: number;
    }
  | {
      type: "research:failed";
      error: string;
    }
  | {
      type: "research:cancelled";
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
  initialState: AgentState = { activeFiberId: null };

  override async _onFiberRecovered(ctx: FiberRecoveryContext) {
    if (ctx.name !== "research") return;

    const snapshot = ctx.snapshot as ResearchSnapshot | null;
    if (!snapshot) return;

    void this._runResearch(
      snapshot.topic,
      this._defaultSteps(),
      snapshot
    ).catch((e) => console.error("[ResearchAgent] Recovery failed:", e));
  }

  private async _runResearch(
    topic: string,
    steps: string[],
    existingSnapshot?: ResearchSnapshot | null
  ): Promise<void> {
    await this.runFiber("research", async (ctx) => {
      const findings = getFindings(topic);
      const completedSteps = existingSnapshot?.completedSteps ?? [];
      const startIndex = completedSteps.length;

      if (startIndex > 0) {
        this.broadcast(
          JSON.stringify({
            type: "research:recovered",
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

        ctx.stash({
          topic,
          completedSteps: [...completedSteps],
          currentStep: step,
          totalSteps: steps.length
        } satisfies ResearchSnapshot);

        this.broadcast(
          JSON.stringify({
            type: "research:step",
            step,
            stepIndex: i,
            totalSteps: steps.length,
            result
          } satisfies ProgressMessage)
        );
      }

      this.broadcast(
        JSON.stringify({
          type: "research:complete",
          results: completedSteps
        } satisfies ProgressMessage)
      );

      this.setState({ activeFiberId: null });
    });
  }

  private _defaultSteps(): string[] {
    return [
      "Literature Review",
      "Data Collection",
      "Analysis",
      "Cross-referencing",
      "Synthesis"
    ];
  }

  // ── Callable methods (client-facing API) ────────────────────────

  @callable()
  startResearch(topic: string): { steps: string[] } {
    const steps = this._defaultSteps();

    this.setState({ activeFiberId: "active" });

    this.broadcast(
      JSON.stringify({
        type: "research:started",
        topic,
        steps
      } satisfies ProgressMessage)
    );

    void this._runResearch(topic, steps).catch((e) =>
      console.error("[ResearchAgent] Research failed:", e)
    );

    return { steps };
  }

  @callable()
  getResearchStatus(): { active: boolean } {
    return { active: this.state?.activeFiberId != null };
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
