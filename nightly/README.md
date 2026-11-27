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

The Pi harness (`agents/harness/pi`) and the OpenCode harness (`agents/harness/opencode`), with the real wake timings (a 30 s heartbeat brings a reset object back). Two suites, each on its own deployment, run at once (`--project pi`, `--project opencode`); together about 15 minutes, each under 30. A scripted model runs the fault cases, so a failure is never the model. The tools report what they run to a separate witness object; after a reset or a code update the suite reads the witness and leaves the probe alone, so only the harness's own wake job can bring the probe back.

- Pi: a replay-safe tool cut off by a reset runs again, once; a tool not marked safe is reported to the model as interrupted and not run again; a tool run cut off by a code update finishes; a call parked on a 40 s deadline is finished by the alarm with nothing touching the object; a codemode script cut off mid-script is replayed (its journaled call is not run again, the replay-safe gate is); a browser tool call runs on a real Browser Rendering session; a twenty-turn conversation on Workers AI, with two resets, answers every question it was asked.
- OpenCode (it runs inside the Durable Object, no container): a run cut off mid model call, by a reset or by a code update, is replayed and ends once; a five-turn conversation on Workers AI with a tool and a reset carries each turn's tool output.

Every room ends with nothing pending and no alarm.

```sh
cd nightly
pnpm run harnesses                       # both suites
pnpm run harnesses --project opencode    # one
```
