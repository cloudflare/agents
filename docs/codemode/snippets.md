# Snippets

A **snippet** is a saved sandbox script — a reusable pattern that already ran and worked. Snippets are durable: they live on the [Runtime](./runtime.md) facet, are addressable by name, and accumulate over time.

Connectors provide raw capability. Snippets are recipes that worked. The split is deliberate: **the model writes and reuses scripts; the developer decides which ones are worth keeping.** Promotion is a curation decision — wire it to a "save this script" button, an eval, or your own heuristics, not to the model's judgement.

## Lifecycle

```ts
// 1. The model writes and runs a script (one execution)
const prs = await github.list_pull_requests({ owner, repo, state: "open" });
```

```ts
// 2. The developer reviews the run and promotes it — e.g. from a @callable
const runs = await runtime.executions(); // newest first
await runtime.saveSnippet("list-open-prs", {
  executionId: runs[0].id, // defaults to the current execution
  description: "List open pull requests for a repository."
});
```

```ts
// 3. The model finds it via codemode.search and runs it by name
const prs = await codemode.run("list-open-prs");
```

`runtime.saveSnippet(name, options?)` snapshots **an execution's code** — by default the current one, or any past run via `executionId`. `runtime.snippets()` lists what's saved and `runtime.deleteSnippet(name)` removes it.

## Parameterised snippets

`codemode.run(name, input)` passes `input` to the snippet. If a snippet takes input, write it to accept an argument:

```ts
// saved as "list-open-prs"
async (input) => {
  return await github.list_pull_requests({
    owner: input.owner,
    repo: input.repo,
    state: "open"
  });
};

// run it
const prs = await codemode.run("list-open-prs", {
  owner: "cloudflare",
  repo: "agents"
});
```

Snippets with no input are written `async () => { ... }` and run with `codemode.run("name")`.

## Discovery

Once saved, snippets surface to the model alongside connector methods:

```ts
codemode.search("open pull requests"); // returns methods AND snippets (kind: "snippet")
codemode.describe("list-open-prs"); // returns the snippet's description + source
```

## API

| Call                                                                      | Who       | Effect                                                          |
| ------------------------------------------------------------------------- | --------- | --------------------------------------------------------------- |
| `runtime.saveSnippet(name, { executionId?, description?, inputSchema? })` | Developer | Promote an execution's script to `name`. Returns the `Snippet`. |
| `runtime.snippets()` / `runtime.deleteSnippet(name)`                      | Developer | List / remove saved snippets.                                   |
| `codemode.run(name, input?)`                                              | Model     | Run a saved snippet, optionally with input.                     |

```ts
interface Snippet {
  name: string;
  description: string;
  code: string; // the saved script source
  savedAt: number;
  inputSchema?: unknown;
}
```

## Snippets are bound to their connector set

Snippets live on the runtime, and the runtime's identity is derived from the connector set it was created with (see [Runtime](./runtime.md#runtime-identity)). This is deliberate:

- A snippet's code references connectors as globals (`github.list_pull_requests(...)`).
- A snippet can only ever be stored in, and run from, a runtime that has those connectors.
- Change the connector set — add, remove, or rename a connector — and you address a **different** runtime. Snippets that referenced a now-absent connector can never surface against a connector set that lacks it.

So snippet validity is **structural**, not tracked per-snippet: a snippet is always run against exactly the connectors it was written with. There is no orphaned-reference problem and no dependency bookkeeping.

## Why durable and curated, not authored

Earlier designs passed in a static list of "skills" at construction. Snippets replace that:

- **Grown, not authored** — snippets come from real runs that worked, instead of a human pre-writing recipes.
- **Curated, not self-promoted** — the developer (or their user) decides what the model gets to reuse; the model doesn't grade its own work.
- **Durable** — they persist on the facet across runs and conversations.
- **Self-consistent** — bound to the connector set that can run them.

There is no separate skill-source interface to implement. Snippets are part of the runtime.
