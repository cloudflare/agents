# Sub-Agents — Multi-Perspective Analysis

A coordinator agent that fans out questions to three specialist sub-agents running in parallel, each with its own LLM call and isolated SQLite storage, then synthesizes the results.

## How It Works

```
CoordinatorAgent (extends AIChatAgent)
  │
  ├──▶ this.subAgent(PerspectiveAgent, "technical")  ──▶ LLM ──▶ analysis
  ├──▶ this.subAgent(PerspectiveAgent, "business")    ──▶ LLM ──▶ analysis
  └──▶ this.subAgent(PerspectiveAgent, "skeptic")     ──▶ LLM ──▶ analysis
                                                              │
                                                        synthesize()
                                                              │
                                                        Final response
```

## Key Pattern

```typescript
import { Agent } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";

// Each sub-agent has its own SQLite and makes its own LLM calls
export class PerspectiveAgent extends Agent<Env> {
  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS analyses (...)`;
  }

  async analyze(perspectiveId: string, question: string): Promise<string> {
    const result = await generateText({
      model,
      system: PERSPECTIVES[perspectiveId].system,
      prompt: question
    });
    this.sql`INSERT INTO analyses ...`;
    return result.text;
  }
}

// Parent fans out to sub-agents in parallel
export class CoordinatorAgent extends AIChatAgent<Env, State> {
  async analyzeQuestion(question: string) {
    const results = await Promise.all(
      ["technical", "business", "skeptic"].map(async (pid) => {
        const agent = await this.subAgent(PerspectiveAgent, pid);
        return agent.analyze(pid, question);
      })
    );
    // ... synthesize results
  }
}
```

## Quick Start

```bash
npm start
```

## Try It

- "Should we rewrite our backend in Rust?"
- "Is AI going to replace software engineers?"
- "Should we build or buy our auth system?"

Watch the three perspective panels fill in as each sub-agent completes its LLM call independently.

## Related

- [gadgets-chat](../gadgets-chat) — multi-room chat via sub-agents
- [gadgets-gatekeeper](../gadgets-gatekeeper) — gated database access via sub-agent boundary
- [gadgets-sandbox](../gadgets-sandbox) — isolated database sub-agent with dynamic Worker isolates
- [design/rfc-sub-agents.md](../../design/rfc-sub-agents.md) — RFC for the sub-agent API
