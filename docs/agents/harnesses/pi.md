---
title: Pi harness (Beta)
pcx_content_type: get-started
description: Host pi-durable sessions in a Durable Object with the beta PiHarness lifecycle capability. Connect a pi-ai model, add tools and skills, and keep sessions running across eviction.
---

`PiHarness` hosts [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) in a Durable Object. It opens Pi over the object's SQLite database and connects Pi's sessions to the Agents SDK lifecycle, which wakes sessions with work after eviction. The API is in beta and may change.

Pi owns everything about a run: the transcript, the inbox of steers and follow-ups, generation, tool calls, retries, and crash recovery. `PiHarness` supplies the storage and the wake. It does not provide a chat protocol or user interface. Your application chooses how clients reach sessions, such as WebSockets, HTTP, or RPC.

## Install the Pi packages

```sh
npm install agents @earendil-works/pi-durable @earendil-works/pi-ai
```

Both Pi packages are optional peer dependencies of `agents`, at `^1.0.0`. The examples use Workers AI through the `AI` binding. To configure the binding and choose other models, refer to [Models for pi-ai](../models-pi-ai.md).

## Create the harness

`PiHarness` uses a factory function to construct Pi's `Harness` so it can be instantiated lazily:

```ts
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";

export class Assistant extends Agent<Env> {
  ai = createAI({ binding: this.env.AI });
  registry = createRegistry();

  harness = new PiHarness({
    harness: ({ storage, context }) => {
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(
        storage,
        { models, registry: this.registry },
        context
      );
    },
    defaults: {
      model: this.ai("@cf/zai-org/glm-4.7-flash"),
      thinkingLevel: "low"
    }
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

| Option     | What it is                                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness`  | Required. Receives `{ storage, context }` and returns Pi's `Harness`, usually from `Harness.open`. Models, the registry, `settings`, `env` and `onReport` are all yours to build here.  |
| `defaults` | What a new session starts with: `model`, a pi-ai `Model` such as `ai("@cf/…")`, and `thinkingLevel`. Without a model, a session's prompts end unanswered (`no_model`) until one is set. |

The factory runs as part of startup, once per isolate. If it throws the operation that triggered it fails and the next operation tries again.

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
    return { content: [{ type: "text", text: String(words) }] };
  }
};

const registry = createRegistry();
registry.install({
  name: "writing",
  sections: [
    { key: "preamble", render: () => "You are an editor.", tag: false }
  ],
  tools: [wordCount]
});
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

harness: async ({ storage, context }) => {
  this.registry.install(await skills(sources));
  return Harness.open(storage, { models, registry: this.registry }, context);
};
```

The existing `@cloudflare/think` skills work out-of-the-box.

## Work with sessions

A session is a Pi conversation. Each has its own transcript, inbox, model and run, and they can run at the same time.

```ts
// The root session.
const { text } = await this.harness.prompt("What is 47 × 19?");

// Another session, on a cheaper model.
const session = await this.harness.sessions.create();
await session.setModel(this.ai("@cf/zai-org/glm-4.7-flash"));

// Durable once it returns; the same operation id twice is one submission.
const receipt = await session.submit("Summarize the latest report", {
  operationId: "report-summary-42"
});
const result = await session.wait(receipt.operationId);
```

| Call                                       | What it does                                                                                                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt(input)`                            | Submits and waits: the answer, and the transcript after it.                                                                                                                              |
| `submit(input, { operationId, whenBusy })` | Returns once Pi has durably accepted the input, before the model runs. A busy session queues it as a follow-up; `whenBusy: "steer"` joins the running work after its current tool round. |
| `wait(operationId, signal?)`               | The operation's result once Pi settles it. Aborting `signal` stops only the wait, not the work.                                                                                          |
| `steer(input)`                             | `submit` with `whenBusy: "steer"`.                                                                                                                                                       |
| `abort(operationId?)`                      | Withdraws a queued operation, or with no id, stops everything running in the session.                                                                                                    |
| `pending()`                                | Operations Pi has not settled yet: queued, or part of the running work.                                                                                                                  |
| `messages()`                               | Pi's transcript entries since the newest reset.                                                                                                                                          |
| `events()`                                 | Pi's agent events: a `snapshot`, then one batch per commit.                                                                                                                              |
| `reset(handoff?)`                          | Starts a new context, optionally from a handoff note.                                                                                                                                    |
| `setModel(model)`                          | Changes this session's model.                                                                                                                                                            |
| `busy()`                                   | Whether a run is going.                                                                                                                                                                  |

`harness.prompt()`, `submit()`, `wait()`, `abort()`, `messages()` and `pending()` act on the root session, or on `{ session }`. `harness.sessions` has `create()`, `fork(from)`, `get(id)` and `list()`, which includes sessions subagents created. `ROOT_SESSION` is the root's id.

`messages()` and `events()` are Pi's own records, not a UI-ready chat transcript. The example below folds them into one.

## How recovery works

The harness schedules one lifecycle job per session with work. The job waits on Pi's tasks, refreshes itself as a heartbeat while they run, and completes when they settle. If the object is evicted or crashes, the job is still due, so its alarm restarts the object. Pi reopens its stored state and resumes the session's work: a replay-safe tool call runs again, and an unsafe one is reported to the model as interrupted.

Every operation waits for the object's startup, which runs the factory. A call over RPC that arrives first waits for it rather than opening Pi on its own.

## Run the example

The [Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi) streams `session.events()` over WebSockets and folds Pi's entries into a browser transcript. Its tools come from a `Workspace` from `@cloudflare/computer`: files, `exec` for JavaScript in a Dynamic Worker, and git. It uses a Workers AI model.
