# Nightly suites

Long end-to-end suites that run against real deployments. The nightly workflow runs them; each one also runs locally with one command. They are not part of `pnpm test`.

Each suite deploys its own Worker under a unique name, drives it, and deletes it at the end. Wrangler needs an account (`CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN` or `wrangler login`). Build the packages first (`pnpm run build` at the root).

## faults

An `AIChatAgent` and a `Think` agent on a scripted fake model, each at the root and as a facet sub-agent of a hub, put through about fifty faults: stream stalls, 429s with `Retry-After`, context overflow, recovery attempts that throw or run out of budget, stops at each stage of a recovery, resets, and approvals over RPC. After each scenario the suite checks what must always hold:

- the object settles, and every recovery that started has ended;
- each request a tab sent gets a `done` frame, ends once, and a hand-off to recovery is always followed by an end;
- no duplicate message ids and no empty assistant message.

```sh
cd nightly
pnpm run faults                                   # deploy, run every scenario on both agents, delete
FAULTS_ONLY=stall,rl429RetryAfter pnpm run faults  # a subset (an unknown name is an error)
FAULTS_CLASSES=fchat,fthink pnpm run faults       # only the facets (chat, think, fchat, fthink)
PROBE_URL=https://<worker>.workers.dev PROBE_KEY=<its PROBE_KEY> pnpm run faults   # against a Worker you deployed
```

Each scenario's full outcome (the stored transcript, events, model calls and every frame the tabs saw) is written to `faults/results/<agent>-<scenario>.json`.

## fuzz

The reset fuzz, on the fault Worker: four rooms at once (Think and AIChatAgent, each with `queue` and `latest` message concurrency), each with four tabs. For six minutes each tab sends requests carrying a fault tag the scripted model acts on (client and server tools, approvals, a tool mid-reply, slow replies, stalls, errors, 429s, overflow), cancels its own or the streaming request, clears the chat now and then, and reconnects. The tabs answer client tools (some twice, some never) and approve or deny approvals. The object is reset every 30 to 90 seconds. Then the room settles and must pass the fault suite's invariants, plus: every request ends once on each connection that saw it and, on a connection still open at the end, ends at all (a tab that reconnected is not yet told how its earlier requests ended: #3330), no tool call is left open behind a later message, every reply follows its own user message, and no user message is stored twice.

The choices come from one seed, printed at the start. Each tab and the resetter draw from their own stream, so `FUZZ_SEED` replays their choices; the server's timing still varies, and tool answers are drawn per call id, which the server makes up. A red run prints the seed, the violations and the last of the driver's trace.

`FUZZ_MINUTES` must be 2 or more: the first reset comes 30 to 90 s in, and a run without one fails.

```sh
cd nightly
pnpm run fuzz                                  # six minutes
FUZZ_MINUTES=3 FUZZ_SEED=689421826 pnpm run fuzz
```

## upgrade

Deploys the probe Worker built on the latest release of `agents`, `@cloudflare/ai-chat` and `@cloudflare/think` (installed together from npm in a scratch directory), leaves live rows in it, then deploys this repository's build over it while a reply streams. Then it checks that:

- a finished chat keeps every message and takes a new turn;
- the reply the deploy cut off is recovered by the new build and ends once;
- an approval asked for before the upgrade still runs its tool, once;
- three queued Think submissions each complete once, in order;
- a running fiber is recovered once, from its last checkpoint;
- a schedule the release set fires once.

```sh
cd nightly
pnpm run upgrade
```

## harnesses

The Pi harness (`agents/harness/pi`) and the OpenCode harness (`agents/harness/opencode`), with the real wake timings (a 30 s heartbeat brings a reset object back). Two suites, each on its own deployment, run at once (`--project pi`, `--project opencode`); together about 18 minutes, each bounded under 30 by its per-turn deadlines. A scripted model runs the fault cases, so a failure is never the model. The tools report what they run to a separate witness object; after a reset or a code update the suite reads the witness and leaves the probe alone, so only the harness's own wake job can bring the probe back.

- Pi: a replay-safe tool cut off by a reset runs again, once; a tool not marked safe is reported to the model as interrupted and not run again; a tool run cut off by a code update finishes; a call parked on a 40 s deadline is finished by the alarm with nothing touching the object; a codemode script cut off mid-script is replayed (its journaled call is not run again, the replay-safe gate is); a browser tool call runs on a real Browser Rendering session; a ten-turn conversation on Workers AI, with two resets, answers every question not cut by a reset and keeps every turn in the saved conversation. Each real-model turn has its own deadline (Pi 120 s, OpenCode 180 s, about three times the measured time per turn), and a missed one fails with the turn, the answers so far and the probe state.
- OpenCode (it runs inside the Durable Object, no container): a run cut off mid model call, by a reset or by a code update, is replayed and ends once; a five-turn conversation on Workers AI with a tool and a reset carries each turn's tool output.

Every room ends with nothing pending and no alarm.

```sh
cd nightly
pnpm run harnesses                       # both suites
pnpm run harnesses --project opencode    # one
```

## soak

Think on a real Workers AI model (`glm-4.7-flash`): three rooms of fourteen turns each, run at once. The turns cycle through a plain question, a server tool, a client tool the tab answers, a tool that needs approval (the tab approves it), a submission, a tool from an extension loaded from source (run in a Dynamic Worker), and a helper Think agent asked as a sub-agent (a facet of the room); three replies per room are cut off by a reset. The model's words are never checked. What must hold: every message the user sent is in the transcript once, in order; every one is answered; no tool call ran twice; every submission completed; the object restarted for each reset; and the fault suite's checks.

```sh
cd nightly
SOAK_LOG=/tmp/soak.log pnpm run soak   # SOAK_LOG: one line per turn, for watching a run
```

## perf

The storage cost of each scenario from the perf probe (SQL statements, rows written and read, KV writes, alarm writes, `storage.sync()` calls, rows and jobs left), at the root and in facets. It runs on local workerd, once with the latest release of the three packages and once with this repository's build, and prints one markdown table, `release / this build`, bold where this build costs more. It is a report: it fails only when a scenario breaks on this build and not on the release. Every scenario that ran shows its counts, also one that timed out, as the perf probe's tables do; under the table the scenarios that failed are listed as broken on this build, failing on the release only, or failing on both. `PERF_PORT` moves the two local runtimes (default 8791 and 8793). A facet scenario also gets a `(sum)` row (leaf, `@mid` and `@root` together), and only that row is bolded. Each call has a 120 s deadline and each WebSocket open 30 s, so a scenario the build cannot finish fails its row. When the local runtime is found down after a scenario, a fresh one starts and the scenario runs once more; it is broken only if it fails again. Once the nightly workflow (#3341) runs it, the table also goes to the job summary.

It differs from the perf probe's `PERF-BUDGET` tables in three rows and one column. The reconnect in `resume-mid-stream` acknowledges the offered stream, as `useAgentChat` does, so `think/resume-mid-stream` and `chat/resume-mid-stream` count the replay; `agent/task-5-steps` leaves its task polls out of the counts. Scenarios that need a stream in flight wait until one is streaming, not for a fixed time. There is no `bytes left` column.

```sh
cd nightly
pnpm run perf                 # every scenario, about ten minutes
pnpm run perf 'think/turn'    # a subset
```
