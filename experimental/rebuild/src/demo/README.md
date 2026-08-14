# demo — eleven strategies across six seams

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
| `Channel`          | `channels/terminal.ts` — a TTY as a surface: readline in, live-tail streaming out (ADR 0005); approvals and settlements are just entries   |                                                                                      |

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
the same in-memory SQLite-backed stack. The terminal is itself a Channel
(`channels/terminal.ts`): input rides the Inbox, and display rides the
channel's **live half** (ADR 0005) — the host hands it a tail of committed
entries plus in-flight chunks. Model output streams token by token, and
everything else the turn does surfaces the moment it hits the log: tool calls
and results as dim `·` lines, plans, debate arguments and compaction summaries
as attributed pass-through entries, failed turns as a visible `✗` line. When
streamed text turns out to be a pass-through entry rather than the reply, an
`↳` attribution line under it says what it was committed as.

Input does not block on the turn: type while the agent is streaming and your
message is admitted live — queued under the default policy, preempting under
`--admission priority`.

The bouncer requires "please" in user messages (and says so when it ignores
you — admission outcomes are log-visible via the runtime's `admitted` marker).
Tollbooth approval requests print inline; resolve the newest with bare
`/approve` / `/reject`, or name one — call ids accept any unique prefix. A
turn parked on a pending effect (the oracle) prints the `/settle <call-id>
<answer>` line that lets you play the outside world. Both commands append
ordinary correlated entries through the channel's own inbox; the host's
`approve()`/`settleTool()` helpers are not involved.

Pass `--db <path>` for a persistent session: restart with the same path and
the recent conversation replays before the prompt; kill the process mid-turn
and the next start's wake scan re-drives the interrupted turn — the durability
suite, live at a terminal.

ELIZA runs with no configuration. The provider-backed model routes deliberately
have no local fallback:

```bash
pnpm demo --model ai-sdk --provider ./my-ai-gateway-model.mjs   # recommended
pnpm demo --model ai-sdk --provider ./my-ai-sdk-model.mjs
pnpm demo --model workers-ai --provider ./my-ai-binding.mjs
pnpm demo --model workers-ai-sdk --provider ./my-ai-binding.mjs
```

An AI SDK provider module exports its model as `default` or `model`; a Workers
AI module exports its binding as `default` or `binding`. A module owning a
socket or child process may also export `close()`, which the runner awaits
last — without it the process cannot exit.

**`my-ai-gateway-model.mjs` (recommended)** reaches Workers AI through
Cloudflare AI Gateway over plain HTTPS — no Workers runtime, no per-provider
key, just a gateway token in `AI_GATEWAY_API_KEY` (or `AI_GATEWAY_KEY`, the
name direnv's shared `.envrc` uses). Put it in a git-ignored `.env` beside
`package.json` — the `demo` script loads it with `--env-file-if-exists` — or
export it. Every request carries the team's `cf-aig-metadata` project header.
This is the route that streams _and_ calls tools, so it brings the tool-driven
strategies to life; the tollbooth and oracle flows below are verified against
it end to end:

```bash
echo 'AI_GATEWAY_API_KEY=…' > .env
pnpm demo --model ai-sdk --provider ./my-ai-gateway-model.mjs \
  --middleware tollbooth
#   → · calling demo/roll_dice {"sides":20}
#   → Approval required — 402 Payment Required — demo/roll_dice costs 2 credits
#   → /approve …  · demo/roll_dice → rolled a 19 (d20)  Agent> I rolled …
```

The gateway speaks an OpenAI-compatible protocol per provider slug, so the
same file reaches other vendors: set `AI_GATEWAY_SLUG=grok` +
`AI_GATEWAY_MODEL=grok-4.3`, or `AI_GATEWAY_SLUG=openai` +
`AI_GATEWAY_MODEL=gpt-5.2`.

Three gateway quirks are handled inside that file, each verified rather than
assumed — worth knowing if you write your own provider module:

- **Do not send an `Authorization` header.** The gateway forwards it verbatim
  to the vendor, where a placeholder key earns a 401. Gateway auth belongs in
  `cf-aig-authorization` alone; the module strips the other one.
- **Model choice decides whether tools work at all.**
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast` returns real `tool_calls` when
  not streaming, but while streaming it emits the call as ordinary content
  text — the agent never sees a tool call. `@cf/openai/gpt-oss-120b` streams
  them properly and is the default here.
- **Workers AI rejects `content: null`.** The AI SDK sends it on an assistant
  message carrying only tool calls (legal at OpenAI); Workers AI 400s with
  `'string' not in 'null'`, which would break every turn after a tool call.
  The module rewrites it to `""` on the way out.

**`my-ai-sdk-model.mjs`** uses the ChatGPT subscription authenticated by
`codex login`. It goes through Codex's **app-server** transport rather than
`codexExec`, and the difference is visible: `codex exec` returns its answer as
one blob, so the AI SDK emits a single text-delta at the end and nothing
streams; the app server holds a JSON-RPC connection open and forwards token
deltas as they arrive. If a provider looks like it "doesn't stream", check
this first — the seam faithfully streams whatever the provider gives it.
Codex also ignores tool definitions, so tool-driven strategies (tollbooth
approvals, the oracle) stay quiet with it.

Missing or invalid providers crash at startup. Relative paths resolve from the
current directory. Type `/quit` or press Ctrl-D to exit.
