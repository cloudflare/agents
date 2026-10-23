---
title: Pi harness
pcx_content_type: get-started
description: Host pi-durable sessions in a Durable Object with the PiHarness lifecycle capability. Connect a pi-ai model, add tools and skills, and keep sessions running across eviction.
---

`PiHarness` hosts [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) in a Durable Object. It opens Pi over the object's SQLite database and connects Pi's sessions to the Agents SDK lifecycle, which wakes sessions with work after eviction.

Pi owns everything about a run: the transcript, the inbox of steers and follow-ups, generation, tool calls, retries, and crash recovery. `PiHarness` supplies the storage and the wake. It does not provide a chat protocol or user interface. Your application chooses how clients reach sessions, such as WebSockets, HTTP, or RPC.

## Install the Pi packages

```sh
npm install agents @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
```

The three Pi packages are optional peer dependencies of `agents`, at `~1.4.0`. pi-durable is experimental, and its API can change in minor releases, so `agents` supports one Pi minor at a time. The examples use Workers AI through the `AI` binding. To configure the binding and choose other models, refer to [Models for pi-ai](../models-pi-ai.md).

## Create the harness

`PiHarness` uses a factory function to construct Pi's `Harness` so it can be instantiated lazily:

```ts
import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";

export class Assistant extends DurableObject<Env> {
  ai = createAI({ binding: this.env.AI });
  registry = createRegistry();

  harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(
        storage,
        { models, registry: this.registry, onWake },
        context
      );
    },
    defaults: {
      model: this.ai("@cf/zai-org/glm-5.3-flash"),
      thinkingLevel: "low"
    }
  });

  lifecycle = Lifecycle.install(this).use(this.harness);

  async ask(prompt: string) {
    return (await this.harness.prompt(prompt)).text;
  }
}
```

`PiHarness` is a Lifecycle capability, so it runs on a plain Durable Object. `Lifecycle.install(this)` gives the object its startup, alarms and job queue, and `.use(this.harness)` installs the harness on it. The object needs a SQLite migration in your Wrangler configuration, like any Durable Object that uses SQLite storage. To use it from an `Agent`, which already has a lifecycle, call `this.lifecycle.use(this.harness)` in the constructor instead.

| Option     | What it is                                                                                                                                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness`  | Required. Receives `{ storage, context, onWake }` and returns Pi's `Harness`, usually from `Harness.open`. Pass `onWake` to `Harness.open`, so the object can hibernate while Pi's tasks sleep (see [How recovery works](#how-recovery-works)). Models, the registry, `settings`, `env` and `onReport` are all yours to build here. |
| `defaults` | What a new session starts with: `model`, a pi-ai `Model` such as `ai("@cf/…")`, and `thinkingLevel`. Without a model, a session's prompts end unanswered (`no_model`) until one is set.                                                                                                                                             |

Create the registry per object, as the `registry` field above does, not at module scope: Pi keeps every `Harness` subscribed to its registry until the `Harness` closes, and an evicted object never closes it.

The factory runs once per open: at startup, and again after a storage error (see [How recovery works](#how-recovery-works)), so keep it safe to run more than once. If it throws the operation that triggered it fails and the next operation tries again.

A model in `defaults` or `session.setModel()` is stored by its provider and id only. Pi resolves it at each request against the `Models` the factory opened Pi with, so it must be a model those `Models` list. Options passed to `ai(id, options)` there, such as `fallback`, are not applied.

## Add tools and prompt sections

Tools and system prompt sections are Pi extensions. An extension is a plain object with a `name`, `tools` and `sections`:

```ts
import { Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  type ToolRegistration
} from "@earendil-works/pi-durable";

const WordCount = Type.Object({ text: Type.String() });

const wordCount: ToolRegistration<typeof WordCount> = {
  name: "word_count",
  description: "Count the words in a text.",
  parameters: WordCount,
  // Pi may run it again after an eviction interrupted it.
  replay: "safe",
  // `text` is typed from `parameters` and is validated by Pi.
  async execute({ text }) {
    const words = text.split(/\s+/).filter(Boolean).length;
    return { output: [{ type: "text", text: String(words) }] };
  }
};

// One per object, as a field: `registry = createWritingRegistry();`
function createWritingRegistry() {
  const registry = createRegistry();
  registry.install({
    name: "writing",
    sections: [
      { key: "preamble", render: () => "You are an editor.", tag: false }
    ],
    tools: [wordCount]
  });
  return registry;
}
```

- **Tool arguments are typed from the schema.** Type a tool as `ToolRegistration<typeof Parameters>`; a bare `ToolRegistration` types its arguments as `unknown`.
- **Replay safety.** `replay: "safe"` lets Pi run a call again after an eviction cut it off. Otherwise the model gets an interrupted result instead of a second run. The default is `"unsafe"`.
- **What a running call can use.** `execute(args, api, context)` gets Pi's operations for the call: `api.output()` for running output, `api.details()` for a UI, and `api.memo()` for values that survive an eviction. `context.abortSignal` is aborted when the call is.
- **Sections.** A section's `render` runs before each request, with the conversation, its agent and offered tools, and committed reads. It is wrapped in `<key>` tags unless `tag` is `false`.

Pi's extensions can do more: hooks on model requests and tool calls (`hook(ToolTask, { beforeTool })`), durable tasks, wrapping another extension's tools, and choosing extensions per conversation. Refer to the [pi-durable README](https://github.com/earendil-works/pi/tree/main/packages/durable) for each. They all work on the registry `PiHarness` opens Pi with.

### Skills

`skills(sources)` turns `agents/skills` sources (refer to [Agent Skills](../../think/index.md#agent-skills)) into a Pi extension named `agents.skills`. It has two tools, `activate_skill` and `read_skill_resource`, and a `skills` section that lists the skills. Install it in the factory, since it reads the sources:

```ts
import { skills } from "agents/harness/pi";

harness: async ({ storage, context, onWake }) => {
  this.registry.install(await skills(sources));
  return Harness.open(
    storage,
    { models, registry: this.registry, onWake },
    context
  );
};
```

The existing `@cloudflare/think` skills work out-of-the-box.

### Browser

`browserTool` from `agents/browser/pi` gives the model a persistent browser it drives with the Chrome DevTools Protocol. Put a `Browser` on the object's Lifecycle and install the tool in an extension:

```ts
import { Browser, browserRun } from "agents/browser";
import { browserTool } from "agents/browser/pi";

readonly browser = new Browser({ provider: browserRun(this.env.BROWSER) });

harness: async ({ storage, context, onWake }) => {
  this.registry.install({
    name: "browser",
    tools: [
      browserTool({ ctx: this.ctx, browser: this.browser, loader: this.env.LOADER })
    ]
  });
  return Harness.open(
    storage,
    { models, registry: this.registry, onWake },
    context
  );
};

readonly lifecycle = Lifecycle.install(this).use(this.browser).use(this.harness);
```

It needs a `browser` binding, a `LOADER` Worker Loader binding, and `export { CodemodeRuntime } from "@cloudflare/codemode"` from the Worker entry. Screenshots come back as images, and each conversation works in its own tab. Refer to [Persistent browser](../browse-the-web.md#persistent-browser) for how it behaves.

## Work with sessions

A session is a Pi conversation. Each has its own transcript, inbox, model and run, and they can run at the same time.

```ts
// The root session.
const { text } = await this.harness.prompt("What is 47 × 19?");

// Another session, on a cheaper model.
const session = await this.harness.sessions.create();
await session.setModel(this.ai("@cf/zai-org/glm-5.3-flash"));

// Durable once it returns; the same operation id twice is one submission.
const receipt = await session.submit("Summarize the latest report", {
  operationId: "report-summary-42"
});
const result = await session.wait(receipt.operationId);
```

| Call                                              | What it does                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt(input)`                                   | Submits and waits: the answer, and the transcript after it.                                                                                                                                                                                                                                                                          |
| `submit(input, { operationId, whenBusy, entry })` | Hands the input to Pi and returns as soon as Pi has saved it, without waiting for the model. If the session is already working, the input waits until that work finishes. With `whenBusy: "steer"`, it joins the running work instead, after the current round of tool calls. `entry` records where the input came from (see below). |
| `wait(operationId, signal?)`                      | The operation's result once Pi settles it. Aborting `signal` stops only the wait, not the work.                                                                                                                                                                                                                                      |
| `steer(input)`                                    | `submit` with `whenBusy: "steer"`.                                                                                                                                                                                                                                                                                                   |
| `abort(operationId?)`                             | Withdraws a queued operation, or with no id, stops everything running in the session.                                                                                                                                                                                                                                                |
| `pending()`                                       | Operations Pi has not settled yet: queued, part of the running work, or `parked` (see [How recovery works](#how-recovery-works)).                                                                                                                                                                                                    |
| `retry()`                                         | Runs again the tasks Pi's restart limit parked in the session's work. Resolves `false` when nothing was parked.                                                                                                                                                                                                                      |
| `messages()`                                      | Pi's transcript entries since the newest reset.                                                                                                                                                                                                                                                                                      |
| `events()`                                        | Pi's agent events: a `snapshot`, then one batch per commit.                                                                                                                                                                                                                                                                          |
| `reset(handoff?)`                                 | Starts a new context, optionally from a handoff note.                                                                                                                                                                                                                                                                                |
| `setModel(model)`                                 | Changes this session's model.                                                                                                                                                                                                                                                                                                        |
| `busy()`                                          | Whether a run is going.                                                                                                                                                                                                                                                                                                              |

`harness.prompt()`, `submit()`, `wait()`, `abort()`, `retry()`, `messages()` and `pending()` act on the root session, or on `{ session }`. `harness.sessions` has `create()`, `fork(from)`, `get(id)` and `list()`, which includes sessions subagents created. `ROOT_SESSION` is the root's id.

`messages()` and `events()` are Pi's own records, not a UI-ready chat transcript. The example below folds them into one.

### Label input the user did not type

Pi records every submitted input as a `pi.user` entry, as if the user typed it. Your code often submits input of its own, such as a prompt from a scheduled job, a webhook payload or the outcome of an approval. To record where that input came from, pass `entry` with a `kind` of your own and any `data` you want to keep with it:

```ts
await session.submit("The deploy was approved. Run the migration.", {
  entry: { kind: "app.approval", data: { approved: true, by: "ben" } }
});
```

The model sees no difference: it still gets the text as a user message. Only the transcript changes. The input is stored with your `kind` and `data` instead of `pi.user`, and `messages()` and `events()` return both, so your UI can show it differently, for example as "Approved by ben" rather than as something the user said. Pi reserves kinds that start with `pi.`, so use a prefix of your own, such as `app.`.

The kind is a label, not a permission. It records what your code said the input was, and nothing checks it. The model reads the input as if the user wrote it, so do not put anything in it that you would not let the user send.

The example app folds the transcript into chat messages, ignores `kind` and `data`, and shows every input as a user message. To show labelled input differently, read them from the entry.

### Inputs queued behind a failed run

A run fails with `model_error` when the model errors and Pi does not retry or the error outlasts its retries, and with `no_model` when the session has no usable model. Its own operation settles `unanswered` with that reason. Pi's `settings.afterFailedRun` decides what happens to the inputs queued behind it. Refer to [Failures and Recovery](https://github.com/earendil-works/pi/tree/main/packages/durable#failures-and-recovery) in the pi-durable README for what each value does. Set it in the factory:

```ts
harness: ({ storage, context, onWake }) =>
  Harness.open(
    storage,
    {
      models,
      registry: this.registry,
      onWake,
      settings: { afterFailedRun: "withdraw" }
    },
    context
  );
```

| Value            | What callers see                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keep` (default) | `pending()` lists the inputs as `queued`, `busy()` is `false`, and `wait()` keeps waiting. The next `submit()` runs them first, in order, then the new input. The next `reset()` runs them in the new context. |
| `continue`       | `wait()` returns their results as usual. If the cause persists, such as a missing model, each queued input fails in its own run.                                                                               |
| `withdraw`       | `wait()` returns `{ status: "unanswered", reason: "run_failed" }`, and `pending()` no longer lists them.                                                                                                       |

With `keep`, the kept inputs are not work to Pi: its `wake()` counts tasks, not queued inputs. The wake job completes, and the object can hibernate until the next `submit()` or `reset()`. Pass a `signal` to `wait()` if a caller should not wait that long. To withdraw a kept input, call `abort(operationId)`, which settles it `unanswered` with reason `aborted`. `session.abort()` with no id stops the whole session, which withdraws every kept input too.

## How recovery works

The harness schedules one lifecycle job, driven by Pi's `wake()`. While Pi has work running, the job waits on it and refreshes itself as a heartbeat. While Pi's tasks sleep, such as a retry backoff, the job is due when the first one wakes. Pi says when through the `onWake` the factory passes to `Harness.open`, and sets no in-memory timer of its own, so the object can hibernate until then. A task that sleeps while other work runs, such as a compaction retry during a generation, is resumed from the job's wait when it is due. Without `onWake` the harness still works, but Pi's timer keeps the object in memory, and billed, while a task sleeps, and the harness logs a warning. When Pi has nothing to do, the job completes. If the object is evicted or crashes, the job is still due, so its alarm restarts the object. Pi reopens its stored state and resumes the session's work: a replay-safe tool call runs again, and an unsafe one is reported to the model as interrupted.

A task that keeps crashing the object would restart it forever, so Pi parks a task cut off by a crash or eviction `settings.restartLimit` times in a row (default 5) without progress. A parked task is not work: the job completes and the object can hibernate. Its operations show as `parked` in `pending()`, and `wait()` keeps waiting. If your factory passes `onReport` to `Harness.open`, Pi reports it there as `task_parked`. Once you have dealt with the cause, `session.retry()` runs it again and wakes the harness; `session.abort()` gives up on it instead.

A storage error closes Pi for good: the call that hit it rejects with the error, and calls and `events()` streams already underway end with Pi's `SessionFailed`, so retry them. If your factory passes `onReport` to `Harness.open`, Pi reports the failure there as `session_failed`. Once the failed Pi has closed, the harness opens Pi again, which runs the factory again, on the next call or the job's next step. Closing waits for running task code, such as a tool call, to return, so code that ignores its abort signal delays the reopen. Pi recovers from what it committed and resumes its work the same way.

If a step of the job fails, such as when the factory throws, the job is not dropped. It tries again after 30 seconds, doubling the delay with each failure in a row up to 10 minutes, and goes back to its usual schedule once a step succeeds. A Durable Object memory-limit reset that fails Pi while the job waits on it counts against the alarm's memory-limit circuit breaker. Lifecycle backs the job off and drops it after repeated resets. The next call opens Pi again and pushes the job again, so Pi's restart limit is what eventually parks a task that keeps causing resets.

Every operation waits for the object's startup, which runs the factory. A call over RPC that arrives first waits for it rather than opening Pi on its own.

## Run the example

The [Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi) streams `session.events()` over WebSockets and folds Pi's entries into a browser transcript. Its tools come from a `Workspace` from `@cloudflare/computer`: files, `exec` for JavaScript in a Dynamic Worker, and git. It uses a Workers AI model.
