/**
 * Sub-Agents Example — Multi-Perspective Analysis
 *
 * The coordinator receives a question from the user, then spawns three
 * PerspectiveAgent facets in parallel. Each facet independently calls the
 * LLM with its own role/persona and produces an analysis. The coordinator
 * waits for all three, then synthesizes them into a final response.
 *
 * Each PerspectiveAgent is a facet — a child DurableObject with its own
 * isolated SQLite. It persists its analysis history independently. The
 * coordinator can abort any slow facet without affecting the others.
 *
 *   ┌─────────── CoordinatorAgent ──────────────────────────────────┐
 *   │                                                                │
 *   │  User question ──▶ analyze() ──┬──▶ facet("technical")        │
 *   │                                ├──▶ facet("business")         │
 *   │                                └──▶ facet("skeptic")          │
 *   │                                                                │
 *   │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐          │
 *   │  │  Technical   │ │   Business   │ │   Skeptic    │          │
 *   │  │  Expert      │ │   Analyst    │ │   (Devil's   │          │
 *   │  │  (facet)     │ │   (facet)    │ │    Advocate) │          │
 *   │  │              │ │              │ │   (facet)    │          │
 *   │  │ own SQLite   │ │ own SQLite   │ │ own SQLite   │          │
 *   │  │ own LLM call │ │ own LLM call │ │ own LLM call │          │
 *   │  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘          │
 *   │         │                │                │                    │
 *   │         └────────────────┼────────────────┘                    │
 *   │                          ▼                                     │
 *   │                    synthesize()                                │
 *   │                          │                                     │
 *   │                          ▼                                     │
 *   │                   Final response                               │
 *   └────────────────────────────────────────────────────────────────┘
 */

import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { DurableObject } from "cloudflare:workers";
import {
  generateText,
  streamText,
  convertToModelMessages,
  tool,
  stepCountIs
} from "ai";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** The three perspectives used for analysis. */
export const PERSPECTIVES = {
  technical: {
    name: "Technical Expert",
    icon: "gear",
    system:
      "You are a senior technical expert. Analyze the question from a purely " +
      "technical standpoint: feasibility, architecture, performance, scalability, " +
      "security implications. Be specific and cite concrete technical concerns. " +
      "Keep your response to 2-3 focused paragraphs."
  },
  business: {
    name: "Business Analyst",
    icon: "chart",
    system:
      "You are a sharp business analyst. Analyze the question from a business " +
      "perspective: market impact, cost/benefit, competitive advantage, risk, " +
      "timeline, and ROI. Be pragmatic and numbers-oriented where possible. " +
      "Keep your response to 2-3 focused paragraphs."
  },
  skeptic: {
    name: "Devil's Advocate",
    icon: "warning",
    system:
      "You are a constructive devil's advocate. Challenge the premise of the " +
      "question. What could go wrong? What are the hidden assumptions? What " +
      "alternatives haven't been considered? Be provocative but fair. " +
      "Keep your response to 2-3 focused paragraphs."
  }
} as const;

export type PerspectiveId = keyof typeof PERSPECTIVES;

export type PerspectiveResult = {
  perspectiveId: PerspectiveId;
  name: string;
  analysis: string;
  timestamp: string;
};

export type AnalysisRound = {
  id: string;
  question: string;
  perspectives: PerspectiveResult[];
  synthesis: string | null;
  timestamp: string;
};

export type SubagentState = {
  analyses: AnalysisRound[];
};

// ─────────────────────────────────────────────────────────────────────────────
// PerspectiveAgent — facet that independently calls the LLM
//
// Each instance has its own role (system prompt), its own SQLite for
// persisting past analyses, and makes its own LLM calls. The coordinator
// cannot see the facet's internal state — it only gets back the analysis
// text through the analyze() RPC method.
// ─────────────────────────────────────────────────────────────────────────────

export class PerspectiveAgent extends DurableObject<Env> {
  private db: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = ctx.storage.sql;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        analysis TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  /**
   * Analyze a question from this perspective. Calls the LLM independently
   * with this perspective's system prompt. Stores the result in the
   * facet's own SQLite.
   *
   * The coordinator calls this on each facet in parallel — three LLM
   * calls running concurrently, each in its own isolated context.
   */
  async analyze(perspectiveId: string, question: string): Promise<string> {
    const perspective =
      PERSPECTIVES[perspectiveId as PerspectiveId] ?? PERSPECTIVES.technical;

    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = await generateText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: perspective.system,
      prompt: question
    });

    const id = crypto.randomUUID();
    this.db.exec(
      "INSERT INTO analyses (id, question, analysis) VALUES (?, ?, ?)",
      id,
      question,
      result.text
    );

    return result.text;
  }

  /** Return past analyses from this facet's storage. */
  getHistory(): { question: string; analysis: string; timestamp: string }[] {
    return [
      ...this.db
        .exec(
          "SELECT question, analysis, timestamp FROM analyses ORDER BY timestamp DESC LIMIT 10"
        )
        .toArray()
    ] as { question: string; analysis: string; timestamp: string }[];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed interface for perspective facet stubs
// ─────────────────────────────────────────────────────────────────────────────

interface PerspectiveFacet {
  analyze(perspectiveId: string, question: string): Promise<string>;
  getHistory(): Promise<
    { question: string; analysis: string; timestamp: string }[]
  >;
}

// ─────────────────────────────────────────────────────────────────────────────
// CoordinatorAgent — orchestrates the sub-agents
// ─────────────────────────────────────────────────────────────────────────────

export class CoordinatorAgent extends AIChatAgent<Env, SubagentState> {
  initialState: SubagentState = {
    analyses: []
  };

  async onStart() {
    this._initTables();
    this._syncState();
  }

  // ─── Facet access ────────────────────────────────────────────────────

  /**
   * Get a PerspectiveAgent facet by role name.
   *
   * Each perspective gets its own named facet with its own SQLite.
   * ctx.facets.get() returns an existing facet or creates a new one.
   */
  private _getFacet(perspectiveId: PerspectiveId): PerspectiveFacet {
    // @ts-expect-error — ctx.facets is experimental
    return this.ctx.facets.get(perspectiveId, () => ({
      // @ts-expect-error — ctx.exports is experimental
      class: this.ctx.exports.PerspectiveAgent
    })) as PerspectiveFacet;
  }

  // ─── Storage ─────────────────────────────────────────────────────────

  private _initTables() {
    this.sql`
      CREATE TABLE IF NOT EXISTS analysis_rounds (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        synthesis TEXT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS perspective_results (
        id TEXT PRIMARY KEY,
        round_id TEXT NOT NULL,
        perspective_id TEXT NOT NULL,
        name TEXT NOT NULL,
        analysis TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;
  }

  private _syncState() {
    const rounds = this.sql<{
      id: string;
      question: string;
      synthesis: string | null;
      timestamp: string;
    }>`
      SELECT id, question, synthesis, timestamp
      FROM analysis_rounds ORDER BY timestamp DESC LIMIT 10
    `;

    const analyses: AnalysisRound[] = rounds.map((round) => {
      const perspectives = this.sql<PerspectiveResult>`
        SELECT perspective_id as perspectiveId, name, analysis, timestamp
        FROM perspective_results
        WHERE round_id = ${round.id}
        ORDER BY perspective_id
      `;
      return { ...round, perspectives };
    });

    this.setState({ analyses });
  }

  // ─── Multi-perspective analysis ──────────────────────────────────────

  /**
   * Run all three perspective agents in parallel, then synthesize.
   *
   * This is the core pattern: fan out to facets, fan in the results.
   * Each facet makes its own independent LLM call with its own context.
   */
  @callable()
  async analyzeQuestion(question: string): Promise<AnalysisRound> {
    const roundId = crypto.randomUUID();

    // Store the round
    this.sql`
      INSERT INTO analysis_rounds (id, question) VALUES (${roundId}, ${question})
    `;
    this._syncState();

    // Fan out: call all three facets in parallel
    const perspectiveIds: PerspectiveId[] = [
      "technical",
      "business",
      "skeptic"
    ];
    const results = await Promise.all(
      perspectiveIds.map(async (pid) => {
        const facet = this._getFacet(pid);
        const analysis = await facet.analyze(pid, question);
        const perspective = PERSPECTIVES[pid];

        // Store each result in the coordinator's own storage
        const resultId = crypto.randomUUID();
        this.sql`
          INSERT INTO perspective_results (id, round_id, perspective_id, name, analysis)
          VALUES (${resultId}, ${roundId}, ${pid}, ${perspective.name}, ${analysis})
        `;
        this._syncState();

        return {
          perspectiveId: pid,
          name: perspective.name,
          analysis,
          timestamp: new Date().toISOString()
        };
      })
    );

    // Synthesize: ask the LLM to combine the three perspectives
    const workersai = createWorkersAI({ binding: this.env.AI });
    const synthesisResult = await generateText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a senior advisor synthesizing multiple perspectives into a " +
        "balanced, actionable recommendation. Be concise — 2-3 paragraphs max.",
      prompt:
        `Question: ${question}\n\n` +
        results.map((r) => `## ${r.name}\n${r.analysis}`).join("\n\n") +
        "\n\nSynthesize these three perspectives into a balanced recommendation."
    });

    // Store synthesis
    this.sql`
      UPDATE analysis_rounds SET synthesis = ${synthesisResult.text}
      WHERE id = ${roundId}
    `;
    this._syncState();

    return {
      id: roundId,
      question,
      perspectives: results,
      synthesis: synthesisResult.text,
      timestamp: new Date().toISOString()
    };
  }

  // ─── Chat ────────────────────────────────────────────────────────────

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const agent = this;

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: `You are a coordinator that manages three specialist sub-agents to analyze questions from multiple perspectives.

When the user asks a question or presents a topic for analysis, use the analyzeFromAllPerspectives tool. This will:
1. Send the question to three independent sub-agents (Technical Expert, Business Analyst, Devil's Advocate)
2. Each sub-agent independently calls an LLM with its own specialized system prompt
3. All three run in parallel, each in its own isolated context
4. A synthesis combines all three perspectives

After receiving the analysis, present a brief summary to the user highlighting key points from each perspective and the synthesis.

For simple conversation (greetings, follow-up questions about results), respond directly without invoking the tool.`,
      messages: await convertToModelMessages(this.messages),
      tools: {
        analyzeFromAllPerspectives: tool({
          description:
            "Analyze a question from three perspectives in parallel: " +
            "Technical Expert, Business Analyst, and Devil's Advocate. " +
            "Each perspective agent runs independently with its own context. " +
            "Returns all three analyses plus a synthesis.",
          inputSchema: z.object({
            question: z.string().describe("The question or topic to analyze")
          }),
          execute: async ({ question }) => {
            const round = await agent.analyzeQuestion(question);
            return {
              question: round.question,
              perspectives: round.perspectives.map((p) => ({
                role: p.name,
                analysis: p.analysis
              })),
              synthesis: round.synthesis
            };
          }
        })
      },
      stopWhen: stepCountIs(3)
    });

    return result.toUIMessageStreamResponse();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
