# demo — ten strategies across five seams

The demo _is the code_: each file is one module, small enough to read on a
slide, focused on the pattern its seam supports. `presets.ts` is the payoff —
three complete agents that share no strategy yet run on identical machinery.

| Seam               | Practical                                                                                                                                  | Wacky                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `LanguageModel`    | `models/ai-sdk.ts` — the whole AI SDK ecosystem as one adapter among peers                                                                 | `models/eliza.ts` — a 1966 therapist behind the same seam                            |
| (composition)      | `models/workers-ai-via-ai-sdk.ts` — the same env.AI binding through both routes: direct adapter or workers-ai-provider → AI SDK → our seam |                                                                                      |
| `ContextAssembler` | `context/compactor.ts` — summaries as private pass-through entries; the engine never knows                                                 | `context/librarian.ts` — an assembler containing a second model that curates context |
| (baseline)         | `context/window.ts` — a context strategy is ~25 lines                                                                                      |                                                                                      |
| `AdmissionPolicy`  | `admission/priority.ts` — source-aware lanes; the pager preempts                                                                           | `admission/bouncer.ts` — no magic word, no turn; policies compose as decorators      |
| `ToolMiddleware`   | `middleware/tollbooth.ts` — x402-shaped payment gating on the approval rail                                                                |                                                                                      |
| `AgentLoop`        | `loops/planner.ts` — plan-and-execute with cold-readable durable plans                                                                     | `loops/debater.ts` — argues with itself before answering                             |

Supporting cast: `tools.ts` — one tool per durability shape (readonly /
mutating / pending).

## Where strategies plug in

- **ReAct / CoT / Reflexion / plan-and-execute** → `AgentLoop` (one step at a
  time along one line; the default harness supplies markers, retries,
  parking, recovery). `planner.ts` and `debater.ts` are the worked examples.
- **Tree-of-thoughts, debate-across-branches, best-of-N, foreign engines
  (Pi, opencode, the AI SDK's own loop)** → `Harness` (different iteration
  topology or commit granularity).
- **Codemode is neither middleware nor a loop**: it is a ToolProvider (one
  `execute_code` tool) that consumes `ToolRuntime.catalog()` to project the
  tool surface into its sandbox — a lens over the tool bar. Not built here.

## Running

From `experimental/rebuild`, start an interactive terminal conversation:

```bash
pnpm demo
pnpm demo --context librarian --admission bouncer --loop debater
pnpm demo --context compactor --admission priority \
  --middleware tollbooth --loop planner
pnpm demo --help
```

The flags swap strategies independently, so every module above can run through
the same in-memory SQLite-backed stack. The bouncer requires "please" in user
messages. Tollbooth requests print their call ID; resolve one with
`/approve <call-id>` or `/reject <call-id>`.

ELIZA runs with no configuration. The provider-backed model routes deliberately
have no local fallback:

```bash
pnpm demo --model ai-sdk --provider ./my-ai-sdk-model.mjs
pnpm demo --model workers-ai --provider ./my-ai-binding.mjs
pnpm demo --model workers-ai-sdk --provider ./my-ai-binding.mjs
```

An AI SDK provider module exports its model as `default` or `model`; a Workers
AI module exports its binding as `default` or `binding`. The included
`my-ai-sdk-model.mjs` uses the ChatGPT subscription authenticated by
`codex login`:

```bash
pnpm demo --model ai-sdk --provider ./my-ai-sdk-model.mjs
```

Missing or invalid providers crash at startup. Relative paths resolve from the
current directory. Type `/quit` or press Ctrl-D to exit.
