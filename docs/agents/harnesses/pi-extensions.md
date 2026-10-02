---
title: Pi harness extensions (Experimental)
pcx_content_type: concept
description: Add tools and system prompt sections to a PiHarness with extensions, plain functions that register transforms. See which pi-durable extension features PiHarness supports.
---

An extension adds tools and system prompt sections to a [`PiHarness`](./pi.md). It is a plain function that receives an `ExtensionContext`. It does not edit the harness's tools or prompt directly; it registers transforms on them. The harness builds its tools and its prompt from empty by running every transform once, in order. The result depends only on which extensions are installed and in what order. The API is experimental and may change.

## Write an extension

Pass extensions to `PiHarness` by name. They run in key order the first time the harness opens, before pi's `Harness`. Pass the `registry` the factory receives to `Harness.open`:

```ts
import { DurableObject } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import { Harness } from "@earendil-works/pi-durable";
import { PiHarness, skills, type PiExtension } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";

const WordCount = Type.Object({ text: Type.String() });

const writing: PiExtension = (ctx) => {
  ctx.prompt.transform((prompt) =>
    prompt.set("preamble", { render: () => "You are an editor.", tag: false })
  );
  ctx.tools.transform((tools) =>
    tools.set("word_count", {
      description: "Count the words in a text.",
      parameters: WordCount,
      replay: "safe",
      // `text` is typed from `parameters`, which pi validates first.
      async execute({ text }) {
        const words = text.split(/\s+/).filter(Boolean).length;
        return { content: [{ type: "text", text: String(words) }] };
      }
    })
  );
};

export class Editor extends DurableObject<Env> {
  readonly harness = new PiHarness({
    harness: ({ storage, context, registry, settings }) =>
      Harness.open(storage, { models, registry, settings }, context),
    extensions: {
      writing,
      skills: skills(sources)
    }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);
}
```

A tool is a pi-durable `ToolRegistration` without `name`; its key in `tools` names it. A section is a pi `PromptSection` without `key`. An extension may be `async`, for example to load what it contributes, but it must register its transforms before it returns. `skills(sources)` is an extension for `agents/skills` sources: it adds the `activate_skill` and `read_skill_resource` tools and a `skills` section.

## Change another extension's contributions

A transform sees everything the transforms before it built, so a later extension can remove or rewrite an earlier one's tools and sections:

```ts
extensions: {
  workspace: workspaceTools(this.workspace),
  // No `exec` in this deployment.
  policy: (ctx) => ctx.tools.transform((tools) => tools.delete("exec"))
}
```

Each tool and section belongs to the extension that first added it, and a replaced entry keeps that owner. After the build, the harness installs one pi extension per extension that contributed anything, under its name. Rewriting another extension's tool therefore changes it wherever that extension applies.

## What PiHarness supports

pi-durable extensions can do more than `PiHarness` extensions do today. This table lists each pi extension feature and how much of it a `PiHarness` extension can use.

| pi-durable extension feature                                                                                                                                                             | pi API                          | `PiHarness`                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools: `replay`, `executionMode`, `prepareArguments`, `outputLimits`, and the full tool `api` (`output`, `details`, `diagnostic`, `memo`, `commit`, tasks, `conversation` for subagents) | `tools`                         | Supported, through `ctx.tools`                                                                                                                                                                       |
| Tool results that add tools, end the run, or hand off (`control`)                                                                                                                        | `ToolExecutionResult.control`   | Supported: a tool's result is pi's                                                                                                                                                                   |
| System prompt sections, rendered before each request from the conversation, its agent, and committed reads                                                                               | `sections`                      | Supported, through `ctx.prompt`                                                                                                                                                                      |
| Removing or rewriting another extension's tools and sections                                                                                                                             | `wraps`                         | Partly. A later extension's change applies wherever the owning extension applies. pi's `wrapTool` and `wrapSection` apply only where the wrapping extension is selected; that is not supported       |
| Generation hooks: `beforeRequest`, `afterResponse`, `onYield`, `afterTools`                                                                                                              | `hook(GenerationTask, …)`       | Not yet                                                                                                                                                                                              |
| Tool hooks: `beforeTool`, `afterTool`                                                                                                                                                    | `hook(ToolTask, …)`             | Not yet                                                                                                                                                                                              |
| Compaction hook: `beforeCompact`                                                                                                                                                         | `hook(CompactionTask, …)`       | Not yet                                                                                                                                                                                              |
| Hooks on custom tasks                                                                                                                                                                    | `hook(task, …)`                 | Not yet                                                                                                                                                                                              |
| Durable custom tasks, resumed after a restart                                                                                                                                            | `tasks`                         | Not yet                                                                                                                                                                                              |
| Extension state in typed documents (`defineDoc`)                                                                                                                                         | `api.commit`, `input.read`      | Partly. A tool can read and write its own documents through `api`, and a section can read them. Seeding a document on every new conversation is not supported                                        |
| Choosing extensions per conversation                                                                                                                                                     | `configure({ extensions })`     | Through pi. Each extension is installed under its name, so `harness.registry.snapshot().extension(name)` returns the pi extension to pass to `configure` on a conversation from `await harness.pi()` |
| Replacing or removing extensions while the object runs                                                                                                                                   | `registry.install`, `uninstall` | Not yet. Extensions run once per isolate, when the harness first opens                                                                                                                               |

To use a feature that is not supported yet, open pi with your own registry in the factory instead of the one it receives. Extensions in `extensions` are then not applied.
