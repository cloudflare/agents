# Context

> **Experimental.** Think's context API may change between releases while it stabilizes.

Context is how a Think agent arranges its system prompt and keeps data the model reads and writes across turns: who the agent is, what it has learned about the user, a knowledge base it can search. You declare it as labelled blocks. Think renders the blocks into the system prompt, gives the model tools for the blocks it can change, and records on the session what each turn was sent, so a long conversation keeps hitting the model provider's prompt cache.

The [session](https://github.com/cloudflare/agents/blob/main/docs/agents/sessions.md) is the transcript: messages, branches, compaction. Context sits beside it. It never changes a message, and the transcript never holds the prompt text.

## Declare blocks

```ts
import { Think } from "@cloudflare/think";
import type { ContextConfig } from "agents/context";

export class MyAgent extends Think<Env> {
  configureContext(): ContextConfig[] {
    return [
      {
        label: "soul",
        provider: { get: async () => "You are a helpful coding assistant." }
      },
      {
        label: "memory",
        description: "Facts learned about the user",
        maxTokens: 1_100
      },
      {
        label: "environment",
        provider: {
          get: async () => `Today is ${new Date().toISOString().slice(0, 10)}.`
        },
        whenChanged: "remind"
      }
    ];
  }
}
```

Each block renders as a section of the system prompt with a header: the label, the description, how much of `maxTokens` it uses, and whether the model can change it (`[readonly]`, `[writable]`, `[searchable]`). An empty read-only block is left out.

What a block can do depends on its provider:

| Provider               | The block is                                     |
| ---------------------- | ------------------------------------------------ |
| none                   | writable, stored in the agent's SQLite           |
| `get()`                | read-only text                                   |
| `get()` and `set()`    | writable, stored wherever your provider keeps it |
| `get()` and `search()` | a summary in the prompt, searched through a tool |

The model writes a writable block with the `set_context` tool and searches a searchable one with `search_context`. `AgentSearchProvider` from `agents/context` is a searchable block backed by full-text search in the agent's SQLite.

Blocks can also come from the `withContext()` chain in `configureSession()`; those render after the ones `configureContext()` returns.

## What the model is sent

The first turn renders every block and records that exact prompt on the session. Every later turn opens with the same text, so the provider can reuse the cached prefix. A write to a block, from the model or from your code, is saved at once but does not change the prompt.

A block declared `whenChanged: "remind"` is for values that move on while the conversation runs: the date, the state of a workspace. When its value changes, the next turn sends the new value once, after that turn's user message, and records it there. Every later request shows it in the same place, so nothing already sent is rewritten. An ordinary block reaches the model at the next refresh.

`this.context.refreshSystemPrompt()` renders the blocks again; the next turn records the new prompt. That costs one prompt-cache miss, so Think does it where the cache is already gone: after a compaction and after the history is cleared. A refresh survives the agent being evicted before its next turn.

A regenerated answer is sent the prompt its own branch was sent, never a newer one. A turn that is recovered or retried after being cut off is sent again exactly as it was first sent; a change or a refresh that arrived in between waits for the next user message.

A compaction summary is written from the stored messages, which never hold a reminder. So when a summary hides the turn that delivered a value, the next request restates that value once, right after the summary. A forked session keeps the prompt and reminders its copied turns were sent with.

## Change blocks from code

`this.context` is available inside your agent class once the agent has started:

```ts
await this.context.setBlock("memory", "Prefers TypeScript.");
await this.context.appendToBlock("memory", "Deploys on Fridays.");
this.context.getBlock("memory")?.content;

await this.context.addBlock({ label: "project", provider: projectBrief });
this.context.removeBlock("project");
await this.context.refreshSystemPrompt();
```

Added and removed blocks enter or leave the prompt at the next refresh.

## What changed

If you used `agents/context` directly before this release:

- `freezeSystemPrompt()`, `refreshSystemPrompt()` and `reminder()` moved from `ContextBlocks` to `Context`, Think's context bound to a session. `ContextBlocks` keeps the blocks and their tools, and no longer takes a prompt store; `renderSystemPrompt()` renders the blocks as they stand.
- Think's `this.context` is a `Context`. The methods you called on it keep their names and signatures.
- An agent upgraded from an earlier release keeps the prompt it last froze: its first turn opens with exactly that text, and an answer from before the upgrade is regenerated with it. A remind block that changed since is sent once on that turn. A conversation started after the upgrade, or after the chat is cleared, does not use it.
- Think no longer writes a `_system_prompt` row; each prompt it records lives on the session.
- `withCachedPrompt(provider)` still works: the provider supplies the prompt frozen before the upgrade. It is read, not written.
