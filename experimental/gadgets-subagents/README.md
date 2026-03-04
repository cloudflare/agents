# Sub-Agents — Multi-Perspective Analysis

A coordinator agent that spawns **three specialist sub-agents**, each independently analyzing a question from a different perspective. All three run in parallel with their own LLM calls and isolated storage. The coordinator synthesizes the results.

## How It Works

```
  CoordinatorAgent
    │
    ├──▶ subAgent("technical")  ──▶ LLM call ──▶ Technical Expert analysis
    ├──▶ subAgent("business")   ──▶ LLM call ──▶ Business Analyst analysis
    └──▶ subAgent("skeptic")    ──▶ LLM call ──▶ Devil's Advocate analysis
                                                    │
                                              synthesize()
                                                    │
                                              Final recommendation
```

Each `PerspectiveAgent` extends `SubAgent` with:

- **Its own SQLite** — stores analysis history independently via `this.sql`
- **Its own LLM call** — different system prompt per role
- **Parallel execution** — all three run concurrently via `Promise.all()`
- **Typed RPC** — `SubAgentStub<PerspectiveAgent>` provides full type safety

## Interesting Files

### `src/server.ts`

- **`PERSPECTIVES`** — the three role definitions with system prompts
- **`PerspectiveAgent`** — extends `SubAgent`. Has `analyze(perspectiveId, question)` which calls the LLM with its role's system prompt and stores the result via `this.sql`.
- **`analyzeQuestion()`** — the core: fans out to all three sub-agents via `await this.subAgent(PerspectiveAgent, pid)` + `Promise.all()`, collects results, then makes a fourth LLM call to synthesize.

### `src/client.tsx`

- **`PerspectiveCard`** — shows each perspective's analysis with role-specific icon and color. Shows "Thinking..." spinner until the facet completes.
- **`AnalysisPanel`** — displays the latest round: three cards + synthesis. Updates in real-time as each facet finishes (via state sync).

## Quick Start

```bash
npm start
```

## Try It

- "Should we rewrite our backend in Rust?"
- "Is AI going to replace software engineers?"
- "Should we build or buy our auth system?"
- "Should we adopt microservices or stay monolithic?"

Watch the three perspective panels fill in as each facet completes its LLM call independently.
