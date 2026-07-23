/**
 * Agents-as-tools example.
 *
 * Demonstrates the framework `runAgentTool` / `agentTool` APIs: a parent Think
 * agent dispatches retained Think sub-agents, streams their chat chunks into
 * the parent UI as `agent-tool-event` frames, and keeps the child facets
 * available for replay and drill-in.
 */

import { callable, routeAgentRequest } from "agents";
import { agentTool } from "agents/agent-tools";
import { Think } from "@cloudflare/think";
import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";

type ResearchInput = { query: string };
type PlanInput = { description: string };

function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const value = record.query ?? record.description;
    if (typeof value === "string") return value;
  }
  return JSON.stringify(input, null, 2);
}

class DemoToolAgent extends Think<Env> {
  override chatRecovery = true;

  override getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  formatAgentToolInput(input: unknown) {
    return {
      id: crypto.randomUUID(),
      role: "user" as const,
      parts: [{ type: "text" as const, text: inputText(input) }]
    };
  }
}

/**
 * Research helper. Investigates a topic in depth via a simulated search tool
 * and produces a short synthesized summary.
 */
export class Researcher extends DemoToolAgent {
  override getSystemPrompt(): string {
    return [
      "You are a focused research helper agent.",
      "Investigate the user's topic in depth, use `web_search` for grounding,",
      "then end with a concise 2-3 paragraph summary."
    ].join(" ");
  }

  override getTools(): ToolSet {
    return {
      web_search: tool({
        description:
          "Search for information on a topic. Returns simulated results for the demo.",
        inputSchema: z.object({
          query: z.string().min(2)
        }),
        execute: async ({ query }) => {
          // Ephemeral progress (rfc-detached-agent-tools §progress). When this
          // Researcher runs as an agent tool (inline or detached/background),
          // these signals ride the child stream as transient
          // `data-agent-progress` parts and surface on the parent's
          // `AgentToolRunState.progress` — the background-runs tray renders a
          // live bar without anyone drilling in. A no-op when run standalone.
          await this.reportProgress({
            phase: "searching",
            fraction: 0.2,
            message: `Searching for "${query}"…`
          });
          await new Promise((resolve) => setTimeout(resolve, 400));
          await this.reportProgress({
            phase: "reading",
            fraction: 0.6,
            message: "Reading 2 sources…"
          });
          await new Promise((resolve) => setTimeout(resolve, 400));
          await this.reportProgress({
            phase: "synthesizing",
            fraction: 0.9,
            message: "Synthesizing findings…"
          });
          // Durable milestone (rfc-detached-agent-tools §progress, 4b). Unlike
          // the ephemeral signals above, a named milestone persists, replays on
          // drill-in, and — for a detached run dispatched with
          // `detached: { onMilestones: ["sources-gathered"] }` — injects a chat
          // notification so the parent model can react before the run finishes.
          await this.reportProgress({
            milestone: "sources-gathered",
            data: { query, sources: 2 }
          });
          return {
            query,
            results: [
              {
                title: `Background on "${query}"`,
                snippet:
                  `Comprehensive overview of ${query}. Recent analysis shows ` +
                  "several trade-offs that depend on workload and deployment shape.",
                url: `https://example.com/search?q=${encodeURIComponent(query)}`
              },
              {
                title: `Recent changes related to "${query}"`,
                snippet:
                  `Latest updates around ${query}, including production lessons ` +
                  "from large open-source and infrastructure deployments.",
                url: `https://example.com/research?topic=${encodeURIComponent(query)}`
              }
            ]
          };
        }
      })
    };
  }
}

/**
 * Planning helper. Uses a simulated file-inspection tool and returns an
 * implementation plan.
 */
export class Planner extends DemoToolAgent {
  override getSystemPrompt(): string {
    return [
      "You are a focused implementation-planning helper.",
      "Use `inspect_file` 1-3 times, then produce a concrete plan with",
      "Overview, Affected files, Step-by-step, and Open questions sections."
    ].join(" ");
  }

  override getTools(): ToolSet {
    return {
      inspect_file: tool({
        description:
          "Inspect a simulated workspace file and summarize what it contains.",
        inputSchema: z.object({
          path: z.string().min(1)
        }),
        execute: async ({ path }) => ({
          path,
          language: path.endsWith(".tsx")
            ? "tsx"
            : path.endsWith(".ts")
              ? "ts"
              : "text",
          summary:
            `Simulated overview of ${path}: primary export plus related ` +
            "utility functions. Tests live alongside the implementation.",
          outline: [
            "primary export",
            "state and helper utilities",
            "nearby tests"
          ]
        })
      })
    };
  }
}

/**
 * Parent chat agent. The framework owns the agent-tool run registry, replay,
 * cancellation bridge, and cleanup. This class owns model policy, prompts, and
 * the example's drill-in gate.
 */
export class Assistant extends Think<Env> {
  override maxConcurrentAgentTools = 4;

  override getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  override getSystemPrompt(): string {
    return [
      "You are a friendly, concise assistant.",
      "Use `research` for deep background, `compare` for two-topic comparisons,",
      "and `plan` for implementation/refactor planning.",
      "When the user wants something investigated 'in the background' or asks you",
      "not to wait, use `research_background`: it returns immediately with a run",
      "id while the Researcher keeps working. Tell the user it is running and",
      "that you will report back when it finishes — a follow-up message will",
      "arrive automatically with the result, and you should react to it then.",
      "After tools return, give the user a brief response grounded in the",
      "agent tools' findings. If a branch reports an error, acknowledge it",
      "instead of pretending it succeeded."
    ].join(" ");
  }

  override getTools(): ToolSet {
    return {
      research: agentTool<ResearchInput>(Researcher, {
        description:
          "Dispatch a Researcher agent to investigate a topic in depth.",
        displayName: "Researcher",
        inputSchema: z.object({
          query: z.string().min(3)
        })
      }),
      plan: agentTool<PlanInput>(Planner, {
        description:
          "Dispatch a Planner agent to produce a concrete implementation plan.",
        displayName: "Planner",
        inputSchema: z.object({
          description: z.string().min(5)
        })
      }),
      research_background: tool({
        description:
          "Dispatch a Researcher agent in the BACKGROUND (detached). Returns " +
          "immediately with a run id; the result is injected back into the " +
          "chat automatically when it finishes, even across reconnects.",
        inputSchema: z.object({
          query: z.string().min(3)
        }),
        execute: async ({ query }) => {
          // Detached: does not block this turn, survives parent eviction, and
          // `notify` posts the completion back into the chat so the model reacts
          // to it later. `cancelBackground(runId)` can stop it early.
          const dispatched = await this.runAgentTool<ResearchInput>(
            Researcher,
            {
              input: { query },
              display: { name: "Researcher" },
              detached: {
                notify: { source: "agents-as-tools-background" },
                maxBudgetMs: 5 * 60 * 1000,
                // Durable milestone narration (4b): when the Researcher reaches
                // "sources-gathered", surface a status line mid-run. The
                // shorthand defaults to "narrate" — a synthetic assistant
                // message injected directly (no model turn), the right fit for a
                // progress update the agent needn't act on. Use
                // `{ names: [...], mode: "react" }` instead when the model should
                // respond to the milestone (e.g. start dependent work).
                onMilestones: ["sources-gathered"]
              }
            }
          );
          return {
            status: "dispatched",
            runId: dispatched.runId,
            note: "Running in the background; I'll report back when it's done."
          };
        }
      }),
      compare: tool({
        description:
          "Dispatch two Researcher agents in parallel to compare related topics.",
        inputSchema: z.object({
          a: z.string().min(3),
          b: z.string().min(3)
        }),
        execute: async ({ a, b }, { toolCallId, abortSignal }) => {
          const [aOutcome, bOutcome] = await Promise.allSettled([
            this.runAgentTool<ResearchInput>(Researcher, {
              input: { query: a },
              parentToolCallId: toolCallId,
              displayOrder: 0,
              display: { name: "Researcher" },
              signal: abortSignal
            }),
            this.runAgentTool<ResearchInput>(Researcher, {
              input: { query: b },
              parentToolCallId: toolCallId,
              displayOrder: 1,
              display: { name: "Researcher" },
              signal: abortSignal
            })
          ]);
          const branch = (
            query: string,
            outcome: PromiseSettledResult<
              Awaited<ReturnType<typeof this.runAgentTool>>
            >
          ) =>
            outcome.status === "fulfilled" &&
            outcome.value.status === "completed"
              ? { query, summary: outcome.value.summary ?? "" }
              : {
                  query,
                  error:
                    outcome.status === "rejected"
                      ? outcome.reason instanceof Error
                        ? outcome.reason.message
                        : String(outcome.reason)
                      : (outcome.value.error ?? outcome.value.status)
                };
          return { a: branch(a, aOutcome), b: branch(b, bOutcome) };
        }
      })
    };
  }

  override async onBeforeSubAgent(
    _request: Request,
    child: { className: string; name: string }
  ): Promise<Response | void> {
    if (child.className !== "Researcher" && child.className !== "Planner") {
      return new Response(`Unknown agent tool class: ${child.className}`, {
        status: 404
      });
    }
    if (!this.hasAgentToolRun(child.className, child.name)) {
      return new Response(
        `Agent tool ${child.className}/${child.name} not found`,
        { status: 404 }
      );
    }
  }

  @callable()
  async clearHelperRuns(): Promise<void> {
    await this.clearAgentToolRuns();
  }

  /**
   * Cancel a background (detached) run early. Idempotent: a no-op if the run
   * already finished. Delivers the `notify` completion with an "aborted" status
   * so the chat still reflects the outcome.
   */
  @callable()
  async cancelBackground(runId: string): Promise<void> {
    await this.cancelAgentTool(runId);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
