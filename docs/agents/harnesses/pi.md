---
title: Pi harness
pcx_content_type: get-started
description: Host pi-durable sessions in a Durable Object with the PiHarness lifecycle capability. Connect a pi-ai model, add tools and skills, and keep sessions running across eviction.
---

`PiHarness` hosts [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) in a Durable Object. It opens Pi over the object's SQLite database and connects Pi's sessions to the Agents SDK lifecycle, which wakes sessions with work after eviction.

Pi owns everything about a run: the transcript, the inbox of steers and follow-ups, generation, tool calls, retries, and crash recovery. `PiHarness` supplies the storage and the wake. It does not provide a chat protocol or user interface. Your application chooses how clients reach sessions, such as WebSockets, HTTP, or RPC.

## Install the Pi packages

```sh
npm install agents @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/pi-schema @earendil-works/chord
```

The four Pi packages are optional peer dependencies of `agents`, at `~1.5.0`. pi-durable is experimental, and its API can change in minor releases, so `agents` supports one Pi minor at a time. A new Pi minor can also store conversations in formats the previous one cannot read: after a conversation runs on Pi 1.5, rolling your Worker back to an `agents` version on Pi 1.4 leaves that conversation unreadable. Roll forward to fix a bad deploy instead. The examples use Workers AI through the `AI` binding. To configure the binding and choose other models, refer to [Models for pi-ai](../models-pi-ai.md).

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
| `defaults` | What a new session starts with: `model`, a pi-ai `Model` such as `ai("@cf/…")`, `thinkingLevel`, and `maxTurns`, the most tool rounds one run takes before it ends unanswered (`turn_limit`). Without a model, a session's prompts end unanswered (`no_model`) until one is set.                                                    |

Create the registry per object, as the `registry` field above does, not at module scope: Pi keeps every `Harness` subscribed to its registry until the `Harness` closes, and an evicted object never closes it.

The factory runs once per open: at startup, and again after a storage error (see [How recovery works](#how-recovery-works)), so keep it safe to run more than once. If it throws the operation that triggered it fails and the next operation tries again.

A model in `defaults` or `session.setModel()` is stored by its provider and id only. Pi resolves it at each request against the `Models` the factory opened Pi with, so it must be a model those `Models` list. Options passed to `ai(id, options)` there, such as `fallback`, are not applied.

## Add tools and prompt sections

Tools and system prompt sections are Pi extensions. An extension is a plain object with a `name`, `tools` and `sections`:

```ts
import {
  createRegistry,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

const WordCount = obj({ text: str() });

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

`skills(sources)` turns `agents/skills` sources (refer to [Agent Skills](../../think/index.md#agent-skills)) into a Pi extension named `agents.skills`. It has two tools, `activate_skill` and `read_skill_resource`, and a `skills` section that lists the skills. Sources can read skills from a Computer Workspace (`workspace()`), an R2 bucket (`r2()`), or code (`manifest()`). Install it in the factory, since it reads the sources:

```ts
import { skills } from "agents/harness/pi";
import * as agentSkills from "agents/skills";

harness: async ({ storage, context, onWake }) => {
  this.registry.install(
    await skills([
      agentSkills.workspace(workspace), // /workspace/.agents/skills
      agentSkills.r2(this.env.SKILLS_BUCKET, { prefix: "skills/" })
    ])
  );
  return Harness.open(
    storage,
    { models, registry: this.registry, onWake },
    context
  );
};
```

The sources are read once, when the factory builds the extension. The tools and their output match `@cloudflare/think`, so a skill behaves the same in both.

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
      browserTool({ browser: this.browser, loader: this.env.LOADER })
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

It needs a `browser` binding, a `LOADER` Worker Loader binding, and `@cloudflare/codemode` installed (only until the deprecated codemode browser APIs are removed from `agents/browser`). Screenshots come back as images, and each conversation works in its own tab. Refer to [Persistent browser](../browse-the-web.md#persistent-browser) for how it behaves.

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

| Call                                                        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt(input)`                                             | Submits and waits: the answer, and the transcript after it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `submit(input, { operationId, whenBusy, whenIdle, entry })` | Hands the input to Pi and returns as soon as Pi has saved it, without waiting for the model. If the session is already working, the input waits until that work finishes. With `whenBusy: "steer"`, it joins the running work instead, after the current round of tool calls. With `whenBusy: "reject"`, it is not admitted: `submit` rejects with Pi's `ConversationBusy` and nothing is saved, so the same `operationId` can be submitted again later. With `whenIdle: "reject"`, an idle session refuses the input the same way, with Pi's `ConversationIdle`, so it never starts a run of its own; with `whenBusy: "steer"`, the input joins the running work or is refused, without racing the run's end. `entry` records where the input came from (see below). |
| `wait(operationId, signal?)`                                | The operation's result once Pi settles it. Aborting `signal` stops only the wait, not the work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `steer(input)`                                              | `submit` with `whenBusy: "steer"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `continue({ operationId })`                                 | Starts a run on the transcript as it is, without a new message, for example after a run ended unanswered. Only an idle session takes one: a busy one rejects with Pi's `ConversationBusy`. Inputs kept behind a failed run join it. A transcript that ends in an answer has nothing to continue: the operation settles `unanswered` with reason `nothing_to_answer`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `abort(operationId?)`                                       | Withdraws a queued operation, or with no id, stops everything running in the session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pending()`                                                 | Operations Pi has not settled yet: queued, or part of the running work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `messages()`                                                | Pi's transcript entries since the newest reset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `watch(window?)`                                            | Pi's view of the session: the newest transcript entries, and the session's live state, such as the answer being streamed, running tools, and why the last run ended without an answer. Each change carries Pi's operations, for a client that forwards them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `entries(query, limit)`                                     | A page of the session's transcript, including entries before its resets. Pages a transcript longer than the view's window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `reset(handoff?)`                                           | Starts a new context, optionally from a handoff note.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `setModel(model)`                                           | Changes this session's model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `busy()`                                                    | Whether a run is going.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`harness.prompt()`, `submit()`, `wait()`, `abort()`, `messages()` and `pending()` act on the root session, or on `{ session }`. `harness.sessions` has `create()`, `fork(from)`, `get(id)` and `list()`, which includes sessions subagents created. `ROOT_SESSION` is the root's id.

`messages()` and `watch()` are Pi's own records, not a UI-ready chat transcript. The example below projects them into one.

```ts
const watch = await session.watch();
render(watch.value);
watch.start(async (call) => {
  if (call.kind === "value") render(call.value);
});

function render(view: ConversationView): void {
  const live = view.docs["pi.live"] as LiveState;
  drawEntries(view.entries);
  if (live.generation?.message) drawStreaming(live.generation.message);
  if (live.runFailure) drawFailure(live.runFailure);
}
```

The window holds the newest 50 entries and grows to 100 before its oldest leave. To render a longer transcript, merge each value into Pi's `ConversationTranscript`, which pages older entries with `session.entries()`.

### Label input the user did not type

Pi records every submitted input as a `pi.user` entry, as if the user typed it. Your code often submits input of its own, such as a prompt from a scheduled job, a webhook payload or the outcome of an approval. To record where that input came from, pass `entry` with a `kind` of your own and any `data` you want to keep with it:

```ts
await session.submit("The deploy was approved. Run the migration.", {
  entry: { kind: "app.approval", data: { approved: true, by: "ben" } }
});
```

The model sees no difference: it still gets the text as a user message. Only the transcript changes. The input is stored with your `kind` and `data` instead of `pi.user`, and `messages()`, `watch()` and `entries()` return both, so your UI can show it differently, for example as "Approved by ben" rather than as something the user said. Pi reserves kinds that start with `pi.`, so use a prefix of your own, such as `app.`.

The kind is a label, not a permission. It records what your code said the input was, and nothing checks it. The model reads the input as if the user wrote it, so do not put anything in it that you would not let the user send.

The example app folds the transcript into chat messages, ignores `kind` and `data`, and shows every input as a user message. To show labelled input differently, read them from the entry.

### Inputs queued behind a failed run

A run fails with `model_error` when the model errors and Pi does not retry or the error outlasts its retries, with `no_model` when the session has no usable model, and with `turn_limit` when it reaches `defaults.maxTurns` (after that round's tools ran). Its own operation settles `unanswered` with that reason; to answer it once the cause is fixed, call `session.continue()`. Pi's `settings.afterFailedRun` decides what happens to the inputs queued behind it. Refer to [Failures and Recovery](https://github.com/earendil-works/pi/tree/main/packages/durable#failures-and-recovery) in the pi-durable README for what each value does. Set it in the factory:

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

The harness schedules one lifecycle job, driven by Pi's `wake()`. While Pi has work running, the job waits on it and refreshes itself as a heartbeat. While Pi's tasks sleep, such as a retry backoff, the job is due when the first one wakes. Pi says when through the `onWake` the factory passes to `Harness.open`, and sets no in-memory timer of its own, so the object can hibernate until then. A task that sleeps while other work runs, such as a compaction retry during a generation, is resumed from the job's wait when it is due. Without `onWake` the harness still works, but Pi's timer keeps the object in memory, and billed, while a task sleeps, and the harness logs a warning. When Pi has nothing to do, the job completes. If the object is evicted or crashes, the job is still due, so its alarm restarts the object. Pi reopens its stored state and resumes the session's work: a replay-safe tool call runs again, and an unsafe one is reported to the model as interrupted. A model request cut off mid-answer is not sent again at once: it counts as a failed attempt under `settings.retry`, and the next attempt waits out the backoff. With no retry left, the operation ends unanswered with reason `interrupted`.

Pi shows a streaming answer and running tool output at once, but stores them in batches: with the next change that depends on them, such as the end of the answer, and at the latest after `settings.progress.persistWithinMs` (default 1,000 ms). A crash mid-stream loses up to that much of the stream, and a generation cut off before its first store leaves no partial answer in the transcript. To store every update instead, at the cost of a storage write each, set `settings: { progress: { persistWithinMs: 0 } }` in the factory's `Harness.open`.

A task that keeps crashing the object would restart it forever, so Pi ends a task cut off by a crash or eviction `settings.restartLimit` times in a row (default 5). A tool call ends with an error result the model sees, and the run goes on. A model request ends its run, and the run's operations end unanswered with reason `restart_limit`. Either way the job completes and the object can hibernate. If your factory passes `onReport` to `Harness.open`, Pi reports it there as `task_interrupted`. To run the work again, call `session.continue()`, which answers the transcript as it is, or submit it again.

A storage error closes Pi for good: the call that hit it rejects with the error, and calls underway reject with Pi's `SessionFailed` and `watch()` handles already open end with `{ kind: "failed" }`, so retry them. If your factory passes `onReport` to `Harness.open`, Pi reports the failure there as `storage_failed`. Once the failed Pi has closed, the harness opens Pi again, which runs the factory again, on the next call or the job's next step. Closing waits for running task code, such as a tool call, to return, so code that ignores its abort signal delays the reopen. Pi recovers from what it committed and resumes its work the same way.

If a step of the job fails, such as when the factory throws, the job is not dropped. It tries again after 30 seconds, doubling the delay with each failure in a row up to 10 minutes, and goes back to its usual schedule once a step succeeds. A Durable Object memory-limit reset that fails Pi while the job waits on it counts against the alarm's memory-limit circuit breaker. Lifecycle backs the job off and drops it after repeated resets. The next call opens Pi again and pushes the job again, so Pi's restart limit is what eventually ends a task that keeps causing resets.

Every operation waits for the object's startup, which runs the factory. A call over RPC that arrives first waits for it rather than opening Pi on its own.

## Run the example

The [Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi) sends `session.watch()` over WebSockets and projects Pi's view into a browser transcript. Its tools come from a `Workspace` from `@cloudflare/computer`: files, `exec` for JavaScript in a Dynamic Worker, and git. It uses a Workers AI model.
