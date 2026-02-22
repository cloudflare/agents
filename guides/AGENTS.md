# AGENTS.md — guides/

In-depth, pattern-oriented tutorials — runnable apps with substantial narrative READMEs that teach how to build a particular kind of agent application.

## How guides differ from examples

|                   | Examples (`/examples`)              | Guides (`/guides`)                                            |
| ----------------- | ----------------------------------- | ------------------------------------------------------------- |
| **Focus**         | One SDK feature or concept          | A pattern or workflow spanning multiple features              |
| **README**        | Short — what it does, how to run it | Walkthrough — architecture, code explanations, best practices |
| **Reader's goal** | "Show me what this looks like"      | "Teach me how to build this kind of app"                      |

If it demonstrates a single feature, it belongs in `/examples`. If it teaches an approach or pattern, it belongs here.

## Structure

Guides are runnable apps with the same structural conventions as examples:

```
guide-name/
  package.json
  vite.config.ts        # must use @cloudflare/vite-plugin
  wrangler.jsonc        # not .toml
  tsconfig.json         # must extend ../../tsconfig.base.json
  index.html
  src/
    server.ts
    client.tsx
  README.md             # the main artifact — this is the tutorial
```

The README is the guide. The code is the supporting material.

## README expectations

A guide README should walk a reader through the application, explaining both what the code does and why it is structured that way. Cover:

1. **What this guide teaches** — the pattern or concept, with context (link to prior art, research, etc.)
2. **Architecture overview** — how the pieces fit together, what components are involved
3. **Code walkthrough** — key sections of code with explanations, not just the full source dumped in
4. **How to run it** — setup, env vars, `npm run dev`
5. **Best practices** — pitfalls, recommendations, what to do in production

Keep it narrative. The reader should be able to follow the README top-to-bottom and understand the pattern without reading every line of source code.

## Conventions

- Follow the same Vite, wrangler, and tsconfig conventions as `/examples` (see `/examples/AGENTS.md`)
- Use `.env.example` (not `.dev.vars.example`) for secrets
- `compatibility_date: "2026-01-28"`, `compatibility_flags: ["nodejs_compat"]`

## Current guides

| Guide                 | Pattern                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `anthropic-patterns/` | Five agent patterns from Anthropic's research (chaining, routing, parallelisation, orchestrator-workers, evaluator-optimizer) |
| `human-in-the-loop/`  | AI agents that request human approval before executing actions                                                                |

## Known issues

- `anthropic-patterns/` uses `wrangler.json` — should be `wrangler.jsonc`
- `human-in-the-loop/` uses `wrangler.toml` — should be `wrangler.jsonc`
