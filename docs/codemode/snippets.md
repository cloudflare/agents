# Snippets

A **snippet** is a saved sandbox script — a reusable pattern the model has already written and verified. Snippets are durable: they live on the [Runtime](./runtime.md) facet, are addressable by name, and accumulate over time as the model promotes working code.

Connectors provide raw capability. Snippets are recipes the model learned.

## Lifecycle

```ts
// 1. The model writes and runs a script
const prs = await github.list_pull_requests({ owner, repo, state: "open" });

// 2. If it works and is worth reusing, save it — captures the current script
await codemode.save("list-open-prs", {
  description: "List open pull requests for a repository."
});

// 3. Later, run it by name
const prs = await codemode.run("list-open-prs");
```

`codemode.save(name, options?)` snapshots **the code of the current execution** — the script that is running when `save` is called. That is the "save what just ran" hook: the model writes a script, confirms it works, and promotes it in one line.

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

Snippets surface alongside connector methods:

```ts
codemode.search("open pull requests"); // returns methods AND snippets (kind: "snippet")
codemode.describe("list-open-prs"); // returns the snippet's description + source
```

## API

| Call                                                  | Effect                                                    |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `codemode.save(name, { description?, inputSchema? })` | Save the current script as `name`. Returns the `Snippet`. |
| `codemode.run(name, input?)`                          | Run a saved snippet, optionally with input.               |

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

## Why durable, not authored

Earlier designs passed in a static list of "skills" at construction. Snippets replace that:

- **Learned, not authored** — the model saves what works, instead of a human pre-writing recipes.
- **Durable** — they persist on the facet across runs and conversations.
- **Self-consistent** — bound to the connector set that can run them.

There is no separate skill-source interface to implement. Snippets are part of the runtime.
