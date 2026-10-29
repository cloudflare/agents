# Context

> **Experimental.** Everything exported from `agents/context` may change between releases while the API stabilizes.

`agents/context` gives an agent labelled blocks of context: instructions, notes the agent keeps for itself, and knowledge it can search. `Context` binds those blocks to a [session](./sessions.md). The session's transcript records the system prompt each stretch of the conversation was sent with and every change delivered after it, and each model request is a projection of that record. Nothing the model has already been sent is rewritten, so the provider's prefix cache holds.

## Bind blocks to a session

```ts
import { DurableObject } from "cloudflare:workers";
import { convertToModelMessages, streamText } from "ai";
import { Context } from "agents/context";
import { Lifecycle } from "agents/lifecycle";
import { Sessions } from "agents/sessions";
import { createWorkersAI } from "workers-ai-provider";

export class Assistant extends DurableObject<Env> {
  readonly sessions = new Sessions({
    // Context keeps its record in message metadata; clients must not write it.
    reservedMetadataKeys: ["cf_agents_context"]
  });
  readonly lifecycle = Lifecycle.install(this).use(this.sessions);
  readonly session = this.sessions.session();
  readonly context = new Context(this.session, {
    storage: this.ctx.storage,
    blocks: [
      { label: "soul", provider: { get: async () => "You are helpful." } },
      { label: "memory", description: "Learned facts", maxTokens: 1_100 },
      {
        label: "environment",
        provider: {
          get: async () => `Today is ${new Date().toISOString().slice(0, 10)}.`
        },
        whenChanged: "remind"
      }
    ]
  });

  async onRequest(request: Request): Promise<Response> {
    await this.session.appendMessage(await request.json(), {
      source: "client"
    });

    const { system, messages } = await this.context.build();
    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.7-code"),
      system,
      messages: await convertToModelMessages(messages),
      tools: await this.context.tools()
    });
    return result.toUIMessageStreamResponse();
  }
}
```

Call `build()` once a turn's user message is stored. It returns:

- `system`: the system prompt the conversation was sent with.
- `messages`: the history as the model is sent it, with each recorded change in place.
- `reminder`: changes it could not record, because the history does not end with a user message. Send them after the cached prefix yourself; the next turn that ends with a user message records them. `null` otherwise.

`build()` is `prepare()` followed by `project()`. Use `project(history)` for any later model call in the same turn: it is pure, and the same history always projects to the same messages.

## What the transcript records

`Context` writes one small record to the metadata of the user message that ends a turn, under `CONTEXT_METADATA_KEY` (`"cf_agents_context"`):

- **A snapshot.** The first turn renders every block into the system prompt and records the sections. Every later request opens with that same text.
- **Changes.** A block declared `whenChanged: "remind"` whose value moved on since the model last saw it is delivered as a reminder after that user message, and recorded there. Later requests render it in the same place, so it is sent once and never moves.

Block values themselves stay in their providers. A host that accepts messages from clients should treat the metadata key as server-owned, for example by listing it in `Sessions` `reservedMetadataKeys`.

## Refreshing the prompt

`refreshSystemPrompt()` reloads every block and returns the new prompt. The next turn that ends with a user message records it as the new snapshot. That is the one deliberate cache bust, so refresh where the cache is already gone, such as after compaction.

A snapshot that compaction hid is simply absent, and the next turn takes a new one.

`freezeSystemPrompt()` returns the prompt the history was sent with, and `reminder()` returns the pending changes. Both only read.

## Blocks

Each block renders as a labelled section of the system prompt. The header carries the label, the description, a token-usage percentage when `maxTokens` is set, and a capability marker (`[readonly]`, `[writable]`, or `[searchable]`). An empty read-only block is left out; writable, searchable, and remind blocks always render.

The provider decides what a block can do. The checks are structural, not nominal.

| Provider             | Block behavior                               |
| -------------------- | -------------------------------------------- |
| None                 | Writable, stored in SQLite                   |
| `get()`              | Read-only text in the prompt                 |
| `get()` + `set()`    | Writable through the `set_context` tool      |
| `get()` + `search()` | Summary in the prompt, `search_context` tool |

A block without a provider is stored in `cf_agents_context_blocks`, keyed by its label (suffixed with the session id outside the default session). Pass `storage` for that, or `defaultProvider` to store it elsewhere.

`AgentSearchProvider` backs a searchable block with FTS5 in the Durable Object's SQLite.

`setBlock()`, `appendToBlock()`, `addBlock()`, and `removeBlock()` change blocks from code. Writes are saved at once. The model sees them as a reminder for a remind block, or at the next refresh.

## Tools

`tools()` returns an AI SDK `ToolSet` built from what the blocks can do:

- `set_context` (`SET_CONTEXT_TOOL`) when any block is writable
- `search_context` (`SEARCH_CONTEXT_TOOL`) when any block is searchable

A model write needs no reminder: the tool call that made it is in the transcript.

## Without a session

`ContextBlocks` is the same set of blocks with no session. It keeps the frozen prompt in memory, or in a `promptStore` you pass, and is what `Context` is built on.

## Harnesses

- **Think** builds a `Context` on its default session from `configureContext()` and the `withContext()` chain in `configureSession()`, records each turn, and refreshes after compaction. `this.context` is that `Context`.
- **`ThinkHarness`** takes a `context` option: a function from a session's handle to a `Context`. Its prompt follows the `system` option, its tools join `tools`, and the harness records each operation's first model call.

## Related

- [Sessions](./sessions.md): durable message trees, streamed history, compaction, and attachment offload
