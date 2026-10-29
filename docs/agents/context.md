# Context

> **Experimental.** Everything exported from `agents/context` and `agents/sessions` may change between releases while the API stabilizes.

Context is what an agent puts in its system prompt: labelled blocks such as a persona, a memory the model can update, or a knowledge base it can search. You declare blocks on a [session](./sessions.md). The session renders them into a system prompt, stores that prompt next to the messages, and hands the model the tools it needs to write or search them.

Sessions store messages. Context decides what the model sees on top of them. Both live on the same handle because they share a goal: keep the prompt byte-for-byte stable between turns so the model provider's prefix cache stays warm.

## Declare blocks

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Sessions } from "agents/sessions";

export class Assistant extends DurableObject<Env> {
  readonly sessions = new Sessions();
  readonly lifecycle = Lifecycle.install(this).use(this.sessions);
  readonly session = this.sessions
    .session()
    .withContext("soul", {
      provider: { get: async () => "You are a helpful assistant." }
    })
    .withContext("memory", {
      description: "Facts learned about the user",
      maxTokens: 1_100
    })
    .withContext("notes", {
      description: "Things worth looking up later",
      searchable: true
    });
}
```

Each call declares one block. A block without a `provider` is stored in the Durable Object's SQLite and the model can write it. `searchable: true` backs the block with a full-text index in the same database.

Declare blocks before the context is first used. A field initializer, as above, is the usual place. Declaring the same label again with the same options does nothing; with different options it throws. To add a block once the context is in use, call `addContext()`.

## Use them in a turn

```ts
import { convertToModelMessages, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

export class Assistant extends DurableObject<Env> {
  // ...fields from above

  async onRequest(_request: Request): Promise<Response> {
    const system = await this.session.freezeSystemPrompt();
    const tools = await this.session.tools();
    const messages = await this.session.getHistory();

    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.7-code"),
      system,
      messages: await convertToModelMessages(messages),
      tools
    });
    return result.toUIMessageStreamResponse();
  }
}
```

`freezeSystemPrompt()` renders the blocks on the first call and stores the result. Every later call returns the stored string, including after the object is evicted and wakes up again. Writes to a block, from the model or from your code, do not change it.

`tools()` returns an AI SDK `ToolSet` built from what the blocks can do:

| Tool             | When                    | Constant              |
| ---------------- | ----------------------- | --------------------- |
| `set_context`    | Any block is writable   | `SET_CONTEXT_TOOL`    |
| `search_context` | Any block is searchable | `SEARCH_CONTEXT_TOOL` |

Import the constants from `agents/context` when a prompt needs to name a tool. An agent with only read-only blocks gets no tools.

## Refresh the prompt

`refreshSystemPrompt()` re-reads every block, re-renders the prompt, and stores it. That is the one deliberate cache bust, so call it when a change should reach the model now rather than at the next natural break.

The session calls it for you after `compact()` and after `clearMessages()`. Both already change what the model sees, so the cached prefix is gone anyway.

## Block types

What a block can do depends on its provider. The checks are structural, not nominal.

| Declaration                            | Block behavior                                               |
| -------------------------------------- | ------------------------------------------------------------ |
| No provider                            | Writable text, stored in SQLite                              |
| `provider` with `get()`                | Read-only text in the prompt                                 |
| `provider` with `get()` and `set()`    | Writable through `set_context`                               |
| `provider` with `get()` and `search()` | Summary in the prompt, searched through `search_context`     |
| `searchable: true`                     | Full-text index in SQLite, searched and written by the model |

`get()` returns the block's current content, or `null` when it has none. An optional `init(label)` receives the block label before first use, so one provider class can serve several labels. `searchable` cannot be combined with `provider`.

Each block renders as a section with a header that carries the label, the description, a token-usage percentage when `maxTokens` is set, and a marker (`[readonly]`, `[writable]`, or `[searchable]`). An empty read-only block is left out. Writable and searchable blocks always render, so the model knows which tools can reach them.

A searchable block shows a count of its entries in the prompt, not the entries themselves. `search_context` returns up to 10 ranked matches.

## Work with blocks in code

```ts
await this.session.replaceContextBlock("memory", "Prefers TypeScript.");
await this.session.appendContextBlock("memory", "Deploys on Fridays.");

this.session.getContextBlock("memory"); // { label, content, tokens, ... }
this.session.getContextBlocks();

await this.session.addContext("project", {
  provider: { get: async () => readProjectBrief() }
});
this.session.removeContext("project");
await this.session.refreshSystemPrompt();
```

`getContextBlock()` and `getContextBlocks()` are synchronous and return what was loaded. Before anything has loaded the blocks they return `null` and an empty list. Call `await this.session.context.load()` during startup to load them eagerly.

`addContext()` and `removeContext()` do not touch the frozen prompt. Call `refreshSystemPrompt()` when the change should reach the model.

## Storage

Blocks without a provider, and the frozen prompt, are rows in `cf_agents_context_blocks`. The table is created the first time a session uses context. Searchable entries live in `cf_agents_search_fts`, separate from the message search index.

The default session (ID `""`) stores a block under its label and the prompt under `_system_prompt`. Any other session appends its ID, so `memory` in session `"support"` is stored as `memory_support`. Sessions in one Durable Object never share blocks or prompts.

To keep the frozen prompt somewhere else, pass any writable provider to `withCachedPrompt()`:

```ts
readonly session = this.sessions
  .session()
  .withContext("soul", { provider: soul })
  .withCachedPrompt(promptStore);
```

## Reminders for changing blocks

Some blocks go stale while the prompt is frozen: the current date, workspace state, project instructions. Refreshing the prompt keeps them current but throws away the cached prefix. Mark such a block `whenChanged: "remind"` to keep both:

```ts
readonly session = this.sessions.session().withContext("environment", {
  provider: {
    get: async () => `Today is ${new Date().toISOString().slice(0, 10)}.`
  },
  whenChanged: "remind"
});

const system = await this.session.freezeSystemPrompt();
const reminder = await this.session.contextReminder(); // null until the date changes
```

`contextReminder()` re-reads each such block. For every block whose current value no longer appears in the frozen prompt, it returns that value under a short note saying it replaces the prompt's copy. Send that text after the cached prefix, for example at the end of the latest user message, and do not store it. The reminder keeps coming back on every call until `refreshSystemPrompt()` folds the value into the prompt.

The comparison is against the stored prompt, so a reminder survives a restart. A remind block always has a section in the prompt, even when it is empty, so the model knows it exists. Any difference in what the provider returns counts as a change, so return only what should count: a date rather than a timestamp.

A standing reminder still costs a little cache. It moves to each new user message, so the previous user message falls out of the cached prefix. The system prompt and everything before that message stay cached.

## Without a session

`ContextBlocks` is the engine a session uses, and `this.session.context` returns the session's instance. It is also exported for a host that builds a prompt with no transcript behind it:

```ts
import { AgentContextProvider, ContextBlocks } from "agents/context";

const context = new ContextBlocks(
  [{ label: "soul", provider: soul }],
  promptStore, // optional: where to keep the frozen prompt
  (label) => provider(label) // optional: storage for blocks without one
);
```

`AgentContextProvider` and `AgentSearchProvider` take anything with a tagged-template `sql` method and an optional storage key.

## Think

`Think` declares its blocks on the default session during startup, from `configureContext()` and from `withContext()` in `configureSession()`:

```ts
import type { ContextConfig } from "agents/context";

class MyAgent extends Think<Env> {
  configureContext(): ContextConfig[] {
    return [
      { label: "soul", provider: { get: async () => "You are helpful." } },
      { label: "memory", description: "Learned facts", maxTokens: 2_000 }
    ];
  }
}
```

Blocks from `configureContext()` render first. The blocks are loaded once the Lifecycle has started and are available through `this.session` and `this.context`.

Think sends reminders itself. Each turn it calls `contextReminder()` and adds the result to the last user message of the model request, or, when the request continues a partial reply, to the user message that asks the model to continue (`TurnContext.messages` in `beforeTurn` already includes it). Nothing is written to the transcript.

## Related

- [Sessions](./sessions.md): durable message trees, streamed history, compaction, and attachment offload
