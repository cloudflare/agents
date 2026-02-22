# Sub-Agents — Multi-Perspective Analysis with Facets

A coordinator agent that spawns **three specialist sub-agents as facets**, each independently analyzing a question from a different perspective. All three run in parallel with their own LLM calls and isolated storage. The coordinator synthesizes the results.

## How It Works

```
  CoordinatorAgent
    │
    ├──▶ facet("technical")  ──▶ LLM call ──▶ Technical Expert analysis
    ├──▶ facet("business")   ──▶ LLM call ──▶ Business Analyst analysis
    └──▶ facet("skeptic")    ──▶ LLM call ──▶ Devil's Advocate analysis
                                                    │
                                              synthesize()
                                                    │
                                              Final recommendation
```

Each PerspectiveAgent is a facet with:

- **Its own SQLite** — stores analysis history independently
- **Its own LLM call** — different system prompt per role
- **Parallel execution** — all three run concurrently via `Promise.all()`

## Interesting Files

### `src/server.ts`

- **`PERSPECTIVES`** — the three role definitions with system prompts
- **`PerspectiveAgent`** — plain DurableObject facet. Has `analyze(perspectiveId, question)` which calls the LLM with its role's system prompt and stores the result in its own SQLite.
- **`CoordinatorAgent._getFacet()`** — gets a named facet via `ctx.facets.get("technical", ...)`. Each perspective is a separate facet instance.
- **`analyzeQuestion()`** — the core: fans out to all three facets via `Promise.all()`, collects results, then makes a fourth LLM call to synthesize.

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
