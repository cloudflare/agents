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
