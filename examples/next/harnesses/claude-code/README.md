# Claude Code as a remote harness runtime

Claude Code runs inside a Cloudflare Container. A Durable Object drives it
over Cap'n Web with the same `Harness` capability every other example in this
directory uses, and the browser talks to that Durable Object with the same
`useHarnessSession()` hook. Nothing in the Worker knows what an SDK message
looks like.

```
browser ──WebSocket──▶ ClaudeCodeSession ──Cap'n Web over ws──▶ harnessd ──▶ claude-agent-sdk
          Harness             Durable Object                     PID 1 in the container
```

## What it demonstrates

- **One developer API, a remote runtime.** `ContainerHarnessRuntime` is the
  only thing that changes versus the in-process examples. `prompt()`,
  `interrupt()`, `reply()`, `events()` and `wait()` are identical.
- **One session per Durable Object, one container per session.** The
  workspace is `/workspace` inside the container, and the container's
  lifetime is `setInactivityTimeout` plus an explicit stop, not a guess.
- **Permissions round trip through a human.** `Bash` and `WebFetch` are on
  the ask list, so the engine's `PreToolUse` gate routes them to
  `canUseTool`, which parks on a durable request. The browser renders it from
  `state.requests` and answers with `reply()`. No promise crosses the wire,
  so an eviction in the middle of a permission costs latency and nothing
  else.
- **Detach on purpose.** When nothing is attached and nothing is in flight
  the control socket closes. Frames keep accumulating in the daemon's
  `node:sqlite` outbox, the daemon rings the doorbell, and the Durable Object
  wakes and re-subscribes from its own cursor. Ordinary operation, not
  recovery.
- **Durable where it matters.** What was asked, what was answered and what is
  still open live in the Durable Object. The model loop, its tools and its
  files live in a sandbox that may be lost at any moment.

## Running it

Containers need Docker running locally.

```sh
npx wrangler secret put ANTHROPIC_API_KEY   # before the first real deploy
npm start                                   # vite dev + wrangler dev
npm run deploy
```

The first `wrangler dev` builds the image, which takes a few minutes. The
build context is the parent directory (`examples/next/harnesses`), because
the daemon compiles against `shared/src/protocol.ts` and
`claude-code/src/claude-code-types.ts` as well as its own sources.

The platform keeps a pool of pre-warmed instances, so the first container a
session gets right after a deploy can still run the previous image. Check the
`daemonVersion` on the `info` route (it carries a digest of the daemon bundle)
before trusting a verification run against a fresh deploy.

### The keyless smoke mode

Set `HARNESS_ENGINE` to `echo` in `wrangler.jsonc` and the image runs the
echo engine instead: prompts come back as `echo: <text>`, a prompt starting
with `ask` raises a permission request, one starting with `slow` waits to be
interrupted. It exercises the whole path, browser to Durable Object to Cap'n
Web to outbox to doorbell, without a model or a key. It is the fastest way to
tell a wiring problem from a model problem.

## Verifying the wire without Docker

The daemon runs on any Node 24 (or 22) host, and the runtime's dial and
probe seams can point at it instead of a container. Start it in echo mode
and run the example's tests: the `live-daemon` suite drives the real
`ContainerHarnessRuntime` against the real daemon over localhost (a turn, a
permission round trip through `reply()`, an interrupt mid-turn) and skips
itself when nothing is listening.

```sh
cd container && npm install && npm run build
CF_HARNESS_ENGINE=echo CF_HARNESS_SECRET=live-secret CF_HARNESS_SESSION_ID=main \
  CF_HARNESS_PORT=18790 node dist/main.mjs &
cd .. && pnpm test
```

## Watching the idle policy

`GET /agents/claude-code-session/<name>/info` reports the container generation
the object last spoke to, whether the platform still has it running, and the
session state. After a turn settles with nobody attached the object closes its
control socket after `detachAfterIdleMs`, keeps the container alive on
`setInactivityTimeout`, and stops it after `stopContainerAfterIdleMs`; the route
shows each step.

`POST /agents/claude-code-session/<name>/restart` evicts the object. Send a
`slow` prompt with `--detach`, restart, and read `info` again: the container
is still running, the daemon finished the turn into its outbox, the doorbell
woke a fresh incarnation, and the transcript has the reply.

`POST /agents/claude-code-session/<name>/kill` destroys the container. Ask
something, kill it, then ask a follow-up that depends on the first answer:
the next prompt launches a new container and the model answers it in context.

## What survives a container death

The harness log, the Sessions transcript and the engine's own transcript all
live in the Durable Object, so a killed, crashed or idled-out container costs
nothing but the launch. The engine replays its own history rather than being
told it, so the runtime hands the mirror back through `configure({ engineLog,
resume })` before the first turn on the new container, signed and redacted
thinking included; `info` reports the `engineSessionId` it will resume.

The workspace filesystem does not survive. `/workspace` starts empty on every
container and the engine's `setup` command is what fills it again, so anything
the model wrote there is gone unless `setup` can re-fetch it or the model
pushed it somewhere durable. That is the one thing to know before treating a
session as long-lived.

## The container

`container/` is a self-contained npm project, deliberately not a workspace
package: the image installs it with `npm ci` from its own lockfile.

```sh
cd container
npm install
npm test        # outbox, a real daemon over a real socket, the projection
npm run build   # one esbuild bundle, the Agent SDK left external
```

`npm test` prints an `ExperimentalWarning` for `node:sqlite` on Node 22. The
image is Node 24, where the warning is gone. The TypeScript project is
`harnessd.tsconfig.json` rather than `tsconfig.json`, because the repository
root typechecks every `tsconfig.json` it can find and this project's
dependencies are installed by `npm` here, not by the workspace.

Inside, `src/daemon.ts` is the only Cap'n Web capability, `src/outbox.ts` is
the only durable state, and `src/engine.ts` is the port an engine fills in.
`src/engines/claude-code.ts` keeps one long-lived `query()` in
streaming-input mode, because the steering surface (`interrupt`, `setModel`) is
streaming-input only and a query per turn would give all of it up, and
`src/engines/claude-code-project.ts` is the pure function that turns SDK
messages into harness frames.

## Credentials

Two ways to reach a model, chosen by what is in the Worker's environment.
Either way, what enters the container is reachable by the model's own tools,
so a container that can run `Bash` holds it; the ask list, the `PreToolUse`
gate, a non-root user and the daemon's `maxBudgetUsd` cap are the
mitigations.

**Through AI Gateway** (recommended). Set `ANTHROPIC_BASE_URL` to the
gateway's Anthropic endpoint and let the gateway hold the provider key, as a
stored key (BYOK) or through Unified Billing. If the gateway is
authenticated, add its token as the `AI_GATEWAY_TOKEN` secret; the Worker
sends it as `cf-aig-authorization` and, because the CLI insists on one, as
the otherwise ignored `ANTHROPIC_API_KEY`. The `AI_GATEWAY_PROJECT` var tags
every request with `cf-aig-metadata`, so a gateway shared by several projects
can attribute the spend.

```sh
npx wrangler secret put AI_GATEWAY_TOKEN        # only for an authenticated gateway
CLOUDFLARE_ACCOUNT_ID=<account> npx wrangler deploy \
  --var ANTHROPIC_BASE_URL:https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic
```

**Directly.** Set the `ANTHROPIC_API_KEY` secret and leave
`ANTHROPIC_BASE_URL` unset.

The tokenless alternative, intercepting the container's outbound HTTPS at
the Worker boundary and forwarding through the `AI` binding, needs the image
to trust a runtime-injected CA and needs SSE to survive the gateway; neither
is verified here, so it is future work.

### Behind Cloudflare Access

When the Worker's hostname sits behind Cloudflare Access, browsers log in as
usual, but the container's doorbell POST would be redirected to the login
page. Create an Access service token, allow it in the application's policy,
and set it as the `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` secrets; the
daemon sends both headers with every ring. Without them the doorbell is
lost and the object falls back to its renewal job, which costs latency, not
correctness.

## Layout

| Path                          | What it is                                         |
| ----------------------------- | -------------------------------------------------- |
| `src/server.ts`               | the Durable Object, the runtime and the entrypoint |
| `src/claude-code-protocol.ts` | `claudeCode()`, the pure engine-spec factory       |
| `src/claude-code-types.ts`    | the vocabulary both sides import, type-only        |
| `src/client.tsx`              | the browser, on `useHarnessSession()`              |
| `container/`                  | the daemon: Cap'n Web, the outbox, the engines     |
| `Dockerfile`                  | the image, built from `examples/next/harnesses`    |

## Known gaps

- The transcript mirror is best-effort on the SDK side: a batch the SDK
  drops after its retries is reported as a `mirror_error` event, and a later
  restore then resumes from a transcript with a hole in it. Nothing detects
  the hole on the wire yet.
- Host tools are declared with a JSON Schema that is converted to the SDK's
  Zod shape at the top level only; nested constraints are not enforced
  inside the container.
- `deferAfterMs` (the SDK's `tool_deferred` path) is not implemented; every
  permission parks.
