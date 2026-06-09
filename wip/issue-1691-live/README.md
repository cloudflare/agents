# issue-1691-live — real-LLM recovery repro

Verifies the [#1691](https://github.com/cloudflare/agents/issues/1691) fix
against **real LLMs** (Workers AI, OpenAI, Anthropic) by interrupting a live
streaming turn the way a Durable Object eviction would, then checking that the
recovered turn lands as its own assistant message instead of being merged into
the previous one.

It covers two engines (`--engine ai-chat` and `--engine think`) so the same
kill/restart sequence can confirm both `@cloudflare/ai-chat` (the package that
had the bug) and `@cloudflare/think` (expected unaffected — it allocates a
distinct message id per recovered turn). It also doubles as a **continuation-
quality** probe: with a long enough turn it measures whether the recovered
continuation cleanly resumes the partial or duplicates/restarts it.

## Why a real LLM matters here

The committed kill/restart e2e
(`packages/ai-chat/src/e2e-tests/chat-recovery.test.ts`) streams a **mock** whose
`start` chunk carries a `messageId`. That makes recovery take the
**provider-id** path — which never had the bug. #1691 only triggers when the
stream has **no** `start.messageId`, which is exactly what
`streamText(...).toUIMessageStreamResponse()` produces with a real model (the id
is assigned client-side). So this repro exercises the real fix path.

## What it does

1. **Turn 1** — a short prompt that completes → assistant message #1.
2. **Turn 2** — a long-streaming prompt; `SIGKILL`s `wrangler dev` mid-stream,
   before the assistant message is persisted.
3. **Restart** — same `--persist-to` dir → `chatRecovery` reconstructs the
   orphaned turn.
4. **Verdict** — turn 2 must be its **own** assistant message (#2) and turn 1
   must be **unchanged**. The bug merged turn 2 into turn 1 (one assistant
   message, corrupted turn-1 text).

## Setup

```bash
pnpm install                 # from repo root (workspace)
wrangler login               # for Workers AI (uses your account)
cp .dev.vars.example .dev.vars   # add OPENAI_API_KEY / ANTHROPIC_API_KEY
```

## Run

From `wip/issue-1691-live`:

```bash
pnpm run repro -- --provider workers-ai
pnpm run repro -- --provider openai
pnpm run repro -- --provider anthropic
```

Flags:

- `--engine` — `ai-chat` (default) or `think`.
- `--provider` — `workers-ai` (default), `openai`, `anthropic`.
- `--port` — default 18991.
- `--kill-delay` — ms before the mid-stream SIGKILL (default 1500). Lower it if
  a run is INCONCLUSIVE (turn 2 finished before the kill).
- `--count` — how high turn 2 is asked to count (default 40). Use a large value
  (e.g. 150) to guarantee a big, **incomplete** partial at kill time, which is
  what the continuation-quality probe needs.
- `--settle` — ms to wait for recovery (default 60000). Use 150000+ for large
  `--count` runs.
- `--stable` — ms the recovered turn-2 message must stay unchanged before it's
  considered "done" (default 20000). See the methodology note below.

Exit code: `0` = PASS, `1` = bug/unexpected, `2` = inconclusive (turn 2 finished
before the kill — rerun with a smaller `--kill-delay`).

Continuation-quality is reported in a separate `CONTINUATION QUALITY` block:
`partial @ kill` vs `final items`, whether it `extended`, and `resets` /
`duplicates` counts (the verdict is `CLEAN_CONTINUATION` or
`DUPLICATED_OR_RESTARTED`).

## Methodology notes (learned the hard way)

- **The continuation is asynchronous.** After recovery, the partial is persisted
  as its own message almost immediately (so `assistantCount >= 2` goes true
  fast), but the actual continuation runs in a **scheduled alarm ~10–13s later**.
  Reading right after `assistantCount >= 2` mis-measures it as "added nothing."
  The harness therefore polls until the turn-2 text stays unchanged for
  `--stable` ms (`pollUntilStable`). An earlier 8s window produced false
  negatives; 20s is safe for the providers tested.
- **Measure partial-vs-final.** `sendChat` accumulates the streamed text so we
  know how many list items had streamed at kill time. A `CLEAN_CONTINUATION`
  that did **not** extend the partial is flagged `(added nothing — inconclusive)`
  rather than counted as a success.
- **The numbered-list prompt is the detector.** A clean prefill-continuation
  yields strictly ascending `1..N`; a regenerate-and-append shows a reset
  (numbers drop) and duplicates. `analyzeContinuation` keys off exactly that.

## Ground truth (as of last run, large partials, `--count 150`)

All three providers continued **cleanly** (0 resets, 0 duplicates). OpenAI
(`gpt-4o-mini`) and Anthropic (`claude-haiku-4-5`) resumed the partial all the
way to a complete 150-item list; Workers AI (`llama-3.3-70b`) continued cleanly
but the model stopped early (correctness fine, completeness model-dependent).
The "some models won't work with `continue: true`" concern did not reproduce.

## Notes

- This is a verification harness (`wip/`), not part of the CI test run.
- Real LLM timing varies; if a run is INCONCLUSIVE, lower `--kill-delay`.
