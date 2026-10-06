---
title: OpenCode harness (Beta)
pcx_content_type: get-started
description: Host OpenCode v2 sessions in a Durable Object with the beta OpenCodeHarness lifecycle capability. Use Workers AI through the AI binding and keep sessions running across eviction.
---

`OpenCodeHarness` hosts [OpenCode v2](https://opencode.ai/v2/docs/build/sdk/cloudflare/) in a Durable Object. It opens OpenCode over the object's SQLite database and connects OpenCode's sessions to the Agents SDK lifecycle, which wakes sessions with work after eviction. It has the same interface as the [Pi harness](./pi.md). The API is in beta and may change.

OpenCode owns everything about a run: the transcript, the inbox of steers and follow-ups, model and tool steps, retries, and crash recovery. `OpenCodeHarness` supplies the storage and the wake. It does not provide a chat protocol or user interface. Your application chooses how clients reach sessions, such as WebSockets, HTTP, or RPC.

## Install the OpenCode packages

```sh
npm install agents @opencode/sdk @opencode/plugin
```

Both OpenCode packages are optional peer dependencies of `agents`, at `^2.0.24`. OpenCode adds about 3.7 MB (gzip) to a Worker, which needs the [Workers Paid plan](https://developers.cloudflare.com/workers/platform/limits/#worker-size).

Wrangler bundles OpenCode as is. Vite's import analysis cannot parse the Scalar API reference UI that `effect` bundles, which OpenCode does not serve here. If Vite reports a syntax error in `httpApiScalar.js`, stub it with this plugin in your Vite config:

```ts
{
  name: "empty-httpapi-scalar",
  enforce: "pre",
  load: (id) =>
    id.includes("/effect/dist/unstable/httpapi/internal/httpApiScalar.js")
      ? 'export const javascript = "";'
      : null
}
```

## Create the harness

`OpenCodeHarness` uses a factory function to open OpenCode, so it opens lazily:

```ts
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { Agent } from "agents";
import { OpenCodeHarness } from "agents/harness/opencode";
import { createAI } from "agents/models/opencode";

export class Assistant extends Agent<Env> {
  ai = createAI({ binding: this.env.AI });

  harness = new OpenCodeHarness({
    opencode: ({ storage }) =>
      OpenCodeWorkerd.create({
        storage,
        config: { default_agent: "build" },
        plugins: [this.ai.plugin]
      }),
    defaults: { model: this.ai("@cf/moonshotai/kimi-k2.7-code") }
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.harness);
  }

  async ask(prompt: string) {
    return (await this.harness.prompt(prompt)).text;
  }
}
```

| Option     | What it is                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opencode` | Required. Receives `{ storage }` and returns an OpenCode host, usually from `OpenCodeWorkerd.create`. Pass `storage` through: it is the object's storage with OpenCode's tables kept under an `opencode_` prefix. Config and plugins are yours to build here. |
| `defaults` | What a new session starts with: `model`, such as `ai("@cf/…")`, and `agent`, such as `"build"`. Without a model, a session uses OpenCode's configured default.                                                                                                |

The factory runs as part of startup. If it throws, the operation that triggered it fails and the next operation tries again.

OpenCode runs periodic background work while it is open, such as catalog refreshes and provider discovery, and its timers keep the object in memory. So the harness closes OpenCode 30 seconds after the last call, once no session is running, and opens it again on the next call. Call `harness.opencode()` each time you need the host rather than keeping it.

### Tables

OpenCode names its tables `session`, `message`, `event`, `kv` and so on, and assumes it owns the database. The `storage` the factory receives rewrites OpenCode's SQL so its tables and indexes are stored as `opencode_session`, `opencode_event` and so on. They do not collide with the SDK's tables or your own, and OpenCode does not see them. OpenCode has no table prefix option yet ([anomalyco/opencode#53577](https://github.com/anomalyco/opencode/issues/53577)).

## Use Workers AI

`createAI` from `agents/models/opencode` makes Workers AI an OpenCode provider. Its requests go through the `AI` binding, so there is no account ID or API token to configure.

```ts
import { createAI } from "agents/models/opencode";

const ai = createAI({ binding: env.AI, gateway: { id: "my-gateway" } });

const model = ai("@cf/moonshotai/kimi-k2.7-code", {
  limit: { context: 256_000, output: 16_384 }
});
// { providerID: "cloudflare", id: "@cf/moonshotai/kimi-k2.7-code" }
```

- **Register the plugin.** Pass `ai.plugin` to `OpenCodeWorkerd.create({ plugins })`. It adds a `cloudflare` provider to OpenCode.
- **Name models with `ai(id)`.** The provider lists the models you have called `ai(id)` with. The result is OpenCode's model reference, for `defaults.model`, `session.setModel()`, or OpenCode's own `sessions.switchModel`.
- **Options.** `ai(id, options)` takes the [`agents/models/ai-sdk` model options](../models.md), such as `gateway`, `fallback` and `reasoningEffort`, plus OpenCode's `limit` on context and output tokens.

Requests are made by the same code as `agents/models/ai-sdk`, so Workers AI models behave the same in both.

## Work with sessions

A session is an OpenCode session. Each has its own transcript, inbox, model and run, and they can run at the same time.

```ts
// The root session.
const { text } = await this.harness.prompt("What is 47 × 19?");

// Another session, on another model.
const session = await this.harness.sessions.create();
await session.setModel(this.ai("@cf/zai-org/glm-4.7-flash"));

// Durable once it returns; the same operation id twice is one submission.
const receipt = await session.submit("Summarize the latest report", {
  operationId: "report-summary-42"
});
const result = await session.wait(receipt.operationId);
```

| Call                                       | What it does                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt(input)`                            | Submits and waits: the answer, and the transcript after it.                                                                                                                        |
| `submit(input, { operationId, whenBusy })` | Returns once OpenCode has durably accepted the input, before the model runs. A busy session queues it as a follow-up; `whenBusy: "steer"` joins the running work at its next step. |
| `wait(operationId, signal?)`               | The operation's result once OpenCode settles it. Aborting `signal` stops only the wait, not the work.                                                                              |
| `steer(input)`                             | `submit` with `whenBusy: "steer"`.                                                                                                                                                 |
| `abort(operationId?)`                      | Withdraws a queued operation or interrupts the run it joined; with no id, withdraws everything queued and interrupts the session.                                                  |
| `pending()`                                | Operations OpenCode has not settled yet: queued, or part of the running work.                                                                                                      |
| `messages()`                               | OpenCode's messages since the newest compaction.                                                                                                                                   |
| `events(signal?)`                          | OpenCode's events for the session as they happen, live text and tool deltas included.                                                                                              |
| `log({ after, follow })`                   | The session's durable events from a sequence number, then new ones as they commit.                                                                                                 |
| `setModel(model)` / `setAgent(agent)`      | Changes this session's model or OpenCode agent.                                                                                                                                    |
| `busy()`                                   | Whether a run is going.                                                                                                                                                            |

`input` is a string, or OpenCode's prompt content: `{ text, files, agents, skills, metadata }`. An operation id is letters, digits, `.`, `_`, `~` and `-`.

`harness.prompt()`, `submit()`, `wait()`, `abort()`, `messages()` and `pending()` act on the root session, or on `{ session }`. `harness.sessions` has `create()`, `fork(from)`, `get(id)` and `list()`, which includes subagent sessions OpenCode spawned. `ROOT_SESSION` (`"ses_root"`) is the root's id. `harness.opencode()` returns OpenCode's host for anything else, such as permissions and forms.

An operation's result is the last assistant message before the next input or the end of the run. If the run fails, the result is `unanswered` with OpenCode's error as `reason`. If the run is interrupted, `reason` is `"interrupted"`. A withdrawn or unknown operation is `unanswered` with `reason` `"not_found"`.

## How recovery works

The harness schedules one lifecycle job per session with work. The job waits on the session while it runs, refreshes itself as a heartbeat, and completes when the session is idle with an empty inbox. If the object is evicted or crashes, the job is still due, so its alarm restarts the object. OpenCode boots, resumes the interrupted turn with a note to the model that it restarted, and the job waits again. An input OpenCode accepted but never started is started again.

Every operation waits for the object's startup, which runs the factory. A call over RPC that arrives first waits for it rather than opening OpenCode on its own.

## What OpenCode cannot do here

OpenCode's Workers profile has no local filesystem, shell, or terminal. Its file, search, shell and terminal tools fail until a sandbox backs them, and version control reports nothing. Add tools through OpenCode plugins (refer to [OpenCode's plugins](https://opencode.ai/v2/docs/build/plugins/)). On boot, OpenCode's local provider plugins (Ollama, LM Studio, vLLM) try to reach `127.0.0.1`. Those requests fail harmlessly.
