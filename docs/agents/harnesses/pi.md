---
title: Pi harness (Experimental)
pcx_content_type: get-started
description: Host pi-durable sessions in a Durable Object with the experimental PiHarness lifecycle capability. Connect a pi-ai model and keep sessions active across eviction.
---

`PiHarness` hosts [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) in a Durable Object. It connects pi's SQLite-backed sessions to the Agents SDK lifecycle, which wakes active sessions after eviction. The API is experimental and may change.

`PiHarness` does not provide a chat protocol or user interface. Your application chooses how clients reach sessions, such as through WebSockets, HTTP, or RPC. The harness exposes pi sessions and their event streams for your application to adapt.

## Install the pi packages

Install `agents` with pi-durable and pi-ai:

```sh
npm install agents @earendil-works/pi-durable @earendil-works/pi-ai
```

Both pi packages are optional peer dependencies of `agents`. The example below uses Workers AI through the `AI` binding. To configure the binding and choose other models, refer to [Models for pi-ai](../models-pi-ai.md).

## Create the harness

Open pi's `Harness` with the storage and background context that `PiHarness` provides. Register the pi-ai provider on a `Models` registry, then attach the capability to the object's lifecycle:

```ts
import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "agents/models/pi-ai";

export class Assistant extends DurableObject<Env> {
  readonly ai = createAI({ binding: this.env.AI });

  readonly harness = new PiHarness({
    harness: ({ storage, context, registry, settings }) => {
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(storage, { models, registry, settings }, context);
    },
    defaults: {
      model: {
        provider: CLOUDFLARE_PROVIDER_ID,
        modelId: "@cf/zai-org/glm-4.7-flash"
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async prompt(input: string) {
    return this.harness.prompt(input);
  }
}
```

The `harness` factory receives a pi storage adapter backed by the Durable Object's SQLite database, a background context for opening pi, pi's registry, and harness-wide settings. Pass the registry and settings to `Harness.open`, and configure pi's models and other `Harness.open` options in this factory.

## Add tools and prompt sections

Tools and system prompt sections come from extensions, plain functions passed to `PiHarness` by name:

```ts
extensions: {
  preamble: (ctx) =>
    ctx.prompt.transform((prompt) =>
      prompt.set("preamble", { render: () => "Be brief.", tag: false })
    ),
  skills: skills(sources)
}
```

To write extensions, and for which pi-durable extension features `PiHarness` supports, refer to [Pi harness extensions](./pi-extensions.md).

`defaults` applies when the harness creates a new session. You can change an individual session's model with `session.setModel()`. Without a model, the session cannot produce an answer until one is set.

## Work with sessions

The root session is available through `harness.prompt()` and `harness.submit()`. Create additional sessions with `harness.sessions.create()`, then use the returned session handle:

```ts
const session = await this.harness.sessions.create();
const receipt = await session.submit("Summarize the latest report", {
  operationId: "report-summary-42"
});
const result = await session.wait(receipt.operationId);
```

`submit()` returns after pi durably accepts the operation. `wait()` returns its result after pi finishes it. Reusing an `operationId` makes a submission idempotent. Set `whenBusy: "steer"` to join the running work after its current tool round; the default queues a follow-up.

Use `session.events()` to read pi's snapshot and committed event batches. Your application can stream those events to clients and build its own view. `session.messages()` returns pi's transcript entries, not a UI-ready chat transcript.

## How recovery works

The harness schedules one lifecycle job for each session with active work. The job waits for pi's tasks, refreshes its wake while they remain active, and completes when they settle. If the Durable Object is evicted, the due job wakes it again; pi reopens its stored state and resumes the session's work.

Pi owns the transcript, operation inbox, generation, tools, retries, and recovery. `PiHarness` supplies durable storage and wake scheduling. It does not move pi's orchestration into the Agents SDK.

## Run the example

The [Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi) connects `session.events()` to WebSockets and projects pi's entries into a browser transcript. It also registers Workspace tools from `@cloudflare/computer` as pi tools, marking which are replay-safe, and configures a Workers AI model.
