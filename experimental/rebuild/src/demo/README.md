# demo — twelve strategies across six seams

The demo _is the code_: each file is one module, small enough to read on a
slide, focused on the pattern its seam supports. `presets.ts` is the payoff —
three complete agents that share no strategy yet run on identical machinery.

| Seam               | Practical                                                                                                                                  | Wacky                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `LanguageModel`    | `models/ai-sdk.ts` — the whole AI SDK ecosystem as one adapter among peers                                                                 | `models/eliza.ts` — a 1966 therapist behind the same seam                            |
| (runnable)         | `models/ai-gateway.ts` — Workers AI via AI Gateway over plain HTTPS; what `--model ai-sdk` actually uses                                   |                                                                                      |
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

## Reading the log back

Every run writes its log to a fresh `.sessions/<timestamp>.db` and prints the
path at startup — not for durability (the tests already prove that) but for
**introspection**: when an answer looks wrong, the log is the record of what
actually happened, and an in-memory session takes it to the grave.

```bash
pnpm log                     # newest session
pnpm log .sessions/….db      # a specific one
pnpm log --full --turn t1    # whole message bodies, one turn
```

It reads through the Engine's own `LogExport.scan`, so it shows exactly what a
cold reader — a recovering host, a support tool — would see:

```
   1 21:22:48.154      user      "Write a detailed 500-word explanation…" [74 chars]
   2 21:22:48.156 t1   turn      admitted
   3 21:22:59.649 t1   assistant "**TCP Congestion Control**…" [5101 chars]
   4 21:22:59.650 t1   turn      completed
```

What is _absent_ is informative too: streamed chunks are ephemeral and never
committed, so anything seen on screen but missing from the log existed only in
flight. That distinction is how you tell a display bug from a model problem —
if the committed text is short, the model really did stop there.

Pass `--db <path>` to resume an existing session (the recent conversation
replays before the prompt; kill a run mid-turn and the next start's wake scan
re-drives the interrupted turn — the durability suite, live at a terminal), or
`--db :memory:` to keep nothing.

ELIZA runs with no configuration. `--model ai-sdk` is a real model:
`models/ai-gateway.ts` reaches Workers AI through Cloudflare AI Gateway over
plain HTTPS — no Workers runtime, no per-vendor key, nothing to pass on the
command line. It needs only a gateway token in `AI_GATEWAY_KEY` (the name the
shared direnv `.envrc` uses), and every request carries the team's
`cf-aig-metadata` project header. There is deliberately no fallback: without a
token it crashes at startup rather than quietly degrading.

This is the route that streams _and_ calls tools, so it is what brings the
tool-driven strategies to life. Both durability rails are verified against it
end to end:

```bash
pnpm demo --model ai-sdk
#   → · calling demo/roll_dice {"sides":20}
#   → · demo/roll_dice → rolled a 11 (d20)
#   → Agent> I rolled a 20-sided die for you and got **11**.

pnpm demo --model ai-sdk --middleware tollbooth
#   → Approval required — 402 Payment Required — demo/roll_dice costs 2 credits
#   → /approve …  · demo/roll_dice → rolled a 19 (d20)  Agent> I rolled …

pnpm demo --model ai-sdk        # then: ask the oracle something
#   → Waiting on demo/consult_oracle — its answer arrives from outside.
#   → /settle <id> the answer is 42  → · demo/consult_oracle → the answer is 42
```

The gateway speaks an OpenAI-compatible protocol per provider slug, so the
same module reaches other vendors without code changes: set
`AI_GATEWAY_SLUG=grok` + `AI_GATEWAY_MODEL=grok-4.3`, or
`AI_GATEWAY_SLUG=openai` + `AI_GATEWAY_MODEL=gpt-5.2`.

The two Workers AI adapters that need a real `env.AI` binding
(`src/models/workers-ai.ts` and `models/workers-ai-via-ai-sdk.ts`) are not
CLI-selectable, because a binding does not exist outside a deployed Worker.
They stay as library modules for that setting.

Three gateway quirks are handled inside `ai-gateway.ts`, each verified rather
than assumed — worth knowing if you point the AI SDK at Workers AI yourself:

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
- **Workers AI stops at 256 output tokens** unless given a cap, so any
  reasonably long answer just ends mid-sentence. The module sets 4096
  (`AI_GATEWAY_MAX_TOKENS` overrides), passed through the contract's own
  `budget.reserveOutputTokens` seam, which nothing had been honouring.

One lesson kept from an earlier Codex-backed route, since it will recur: if a
model appears not to stream, suspect the provider transport before this code.
`codex exec` returns its whole answer as one blob, so the AI SDK emitted a
single text-delta at the very end and the terminal printed one line — the seam
faithfully streams whatever the provider gives it, and no more.

Missing credentials crash at startup. Type `/quit` or press Ctrl-D to exit.
