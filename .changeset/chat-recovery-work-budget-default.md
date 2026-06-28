---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

Fix neverending chat-recovery retries when a Durable Object isolate runs out of memory mid-turn ([#1825](https://github.com/cloudflare/agents/issues/1825)).

`chatRecovery.maxRecoveryWork` now defaults to a generous finite backstop (`1000`) instead of `Infinity`. An isolate that exceeds its memory limit and is reset mid-stream has usually already streamed a little content, which bumps the durable progress counter. On the next wake recovery reads that as forward progress and **resets both progress-keyed bounds** — the attempt cap (`maxAttempts`) and the no-progress window (`noProgressTimeoutMs`) — and because each crash lands inside the alarm-debounce window the attempt counter is pinned too. With the work budget disabled (`Infinity`), no instrument could ever seal the turn, so recovery re-ran the turn (and its LLM calls) forever. The work meter is the one signal that keeps climbing across such a loop, so a finite default seals a runaway with `reason="work_budget_exceeded"` instead of looping.

Work only accrues from the first interruption until the turn completes, so a normal interrupted turn never approaches the cap. A very long agentic turn that legitimately produces a large amount of content under heavy interruption can raise `maxRecoveryWork` (or set it to `Infinity` to restore the previous fully-unbounded behavior, ideally paired with a `shouldKeepRecovering` predicate that bounds the runaway via real token/cost accounting).
