# Context

> **Experimental.** Everything exported from `agents/context` may change between releases while the API stabilizes.

`agents/context` assembles an agent's system prompt from labelled blocks. A block is a piece of prompt text with a storage provider behind it. What the provider can do decides how the block behaves and which tools the model gets for it.

Context is prompt assembly. It is not conversation storage. It composes with [`agents/sessions`](./sessions.md) rather than living inside it, so an agent can have a prompt without a transcript, or a transcript without a prompt.

## Blocks

```ts
import { ContextBlocks } from "agents/context";

const context = new ContextBlocks([
  {
    label: "soul",
    provider: { get: async () => "You are a helpful assistant." }
  },
  {
    label: "memory",
    description: "Facts learned about the user",
    maxTokens: 1_100,
    provider: memoryProvider
  }
]);

await context.load();
const system = context.toSystemPrompt();
const tools = await context.tools();
```

Each block renders as a labelled section of the system prompt. The header carries the label, the description, a token-usage percentage when `maxTokens` is set, and a capability marker (`[readonly]`, `[writable]`, `[loadable]`, or `[searchable]`).

An empty read-only block is skipped. Writable, loadable, and searchable blocks always render so the model knows which tools can address them.

## Providers

The provider decides the block's behavior. The checks are structural, not nominal.

| Provider shape          | Block behavior                                      |
| ----------------------- | --------------------------------------------------- |
| `get()`                 | Read-only text in the prompt                        |
| `get()` + `set()`       | Writable through the `set_context` tool             |
| `get()` + `load(key)`   | Metadata listing in the prompt, `load_context` tool |
| `get()` + `search(key)` | Summary in the prompt, `search_context` tool        |

`get()` returns the block's current content, or `null` when it has none. An optional `init(label)` receives the block label before first use, so one provider class can serve several labels.

`ContextBlocks` also accepts a `defaultProvider` factory. A block declared without a `provider` is then wired to whatever that factory returns for its label, which is how a host offers durable writable blocks by label alone.

### Durable SQLite blocks

`AgentContextProvider` stores one block per row in `cf_agents_context_blocks` in the Durable Object's own SQLite database:

```ts
import { AgentContextProvider } from "agents/context";

const context = new ContextBlocks([
  { label: "memory", provider: new AgentContextProvider(this, "memory") }
]);
```

The constructor takes anything with a tagged-template `sql` method, which an `Agent` already has. The label argument is optional: `init()` fills it in from the block declaration.

### Searchable blocks

`AgentSearchProvider` backs a block with a Durable Object FTS5 table:

```ts
import { AgentSearchProvider } from "agents/context";

const context = new ContextBlocks([
  { label: "knowledge", provider: new AgentSearchProvider(this) }
]);
```

`get()` renders a count of indexed entries rather than the entries themselves. `search(query)` returns up to 10 ranked matches through the `search_context` tool. `set(key, content)` replaces one keyed entry.

The FTS5 table is the only store for these entries. A mirror row table would double the billed writes of every indexed entry to serve a count and a lookup the index already answers. Entries live in `cf_agents_search_fts`, namespaced by label, separate from the Sessions message index.

### Skill blocks

`R2SkillProvider` backs a block with an R2 bucket of keyed documents:

```ts
import { R2SkillProvider } from "agents/context";

const skills = new R2SkillProvider(env.SKILLS_BUCKET, {
  prefix: "skills/",
  keys: ["code-review", "debugging"]
});
```

`get()` lists keys and descriptions, so the prompt carries the catalog rather than the content. Descriptions come from the R2 object's `description` custom metadata. `load(key)` fetches one document on demand through the `load_context` tool. `keys`, when given, restricts which prefix-relative keys the provider will list or load.

This is prompt-level loadable context. First-class Agent Skills are a different system and live in `agents/skills`.

## Frozen prompts

`toSystemPrompt()` renders once and caches. Later calls return the same string, so the provider's prefix cache stays warm across turns. `setBlock()` writes to the provider immediately but deliberately does not update the snapshot. Call `refreshSnapshot()` to re-render from current block state.

`freezeSystemPrompt()` adds durability. Pass a `promptStore` (any writable provider) as the second constructor argument and the frozen prompt is persisted:

```ts
const context = new ContextBlocks(
  configs,
  new AgentContextProvider(this, "_system_prompt"),
  (label) => new AgentContextProvider(this, label)
);

const system = await context.freezeSystemPrompt();
```

`freezeSystemPrompt()` returns the stored prompt when one exists, and otherwise loads providers, renders, and persists. So a cold wake reuses the exact prompt string the model already cached instead of re-rendering a subtly different one.

`getSystemPromptForEstimate()` reads the same cached prompt for token estimation without persisting a new one. `refreshSystemPrompt()` reloads every provider, re-renders, and overwrites the stored prompt.

## Tools

`tools()` returns an AI SDK `ToolSet` wired from what the blocks can do:

- `set_context` when any block is writable
- `load_context` and `unload_context` when any block is backed by a skill provider
- `search_context` when any block is backed by a search provider

An agent with only read-only blocks gets no tools at all.

## Loaded skills across wakes

Loading a skill is a tool call recorded in the transcript, so which skills are loaded is derivable from stored messages rather than from a separate table.

```ts
import { restoreLoadedSkills, reclaimLoadedSkill } from "agents/context";

await restoreLoadedSkills(context, session);
```

`restoreLoadedSkills()` scans assistant rows for `load_context` and `unload_context` results and replays them into the block state. It reads in bounded batches with `reconstruct: "pointer"`, so a long transcript never materializes and no attachment bytes are read. It returns immediately when no configured provider is skill-capable.

`reclaimLoadedSkill(session, label, key)` replaces the stored `load_context` tool result with a short `[skill unloaded: <key>]` marker, so the model stops seeing the skill's content after an unload. Register it through `setUnloadCallback()` and `ContextBlocks` calls it on every unload without knowing anything about storage.

Both helpers take a narrow `SkillSession` port: anything with `historyBatches()` and `updateMessage()`. A `Session` from `agents/sessions` satisfies it.

## Think

`Think` builds its `ContextBlocks` from `configureContext()` during startup:

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

A block declared without a provider is auto-wired to durable per-agent SQLite. The frozen system prompt is always persisted, in `_system_prompt`, so there is nothing to opt into.

The assembled blocks are available as `this.context` after `onStart()`.

## Related

- [Sessions](./sessions.md) - durable message trees, streamed history, compaction, and attachment offload
