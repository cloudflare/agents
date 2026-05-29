# Skills

Skills are reusable code patterns that combine connector methods. Connectors provide raw capability; skills provide recipes.

Codemode does not implement skill management — it only defines the interface. Think, bundled manifests, R2 sources, or any other system implements `CodemodeSkillSource`; codemode consumes it.

## Interface

```ts
interface CodemodeSkill {
  /** Unique skill name. Appears in codemode.search results. */
  name: string;
  /** Short description for search/catalog. */
  description: string;
  /** The code pattern — an async arrow function string. */
  code: string;
  /** JSON Schema for skill input parameters. */
  inputSchema?: unknown;
  /** Optional longer markdown instructions shown on describe. */
  instructions?: string;
}

interface CodemodeSkillSource {
  /** Stable identifier for this source. */
  id: string;
  /** List all skills from this source. */
  list(): Promise<CodemodeSkill[]>;
  /** Load a specific skill by name. */
  load?(name: string): Promise<CodemodeSkill | null>;
}
```

## Usage

Pass skill sources to `createProxyTool`:

```ts
createProxyTool({
  ctx: this.ctx,
  executor,
  connectors: [github, repoApi],
  skills: [bundledSkills, thinkSkills]
});
```

## Defining skills

A skill source is any object with `id`, `list()`, and optionally `load()`:

```ts
import type { CodemodeSkillSource } from "@cloudflare/codemode";

export const bundledSkills: CodemodeSkillSource = {
  id: "bundled",
  async list() {
    return [
      {
        name: "list-open-prs",
        description: "List open pull requests for a repository.",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" }
          },
          required: ["owner", "repo"]
        },
        code: `async ({ owner, repo }) => {
          return await github.list_pull_requests({ owner, repo, state: "open" });
        }`
      },
      {
        name: "repo-overview",
        description: "Get combined repository metadata and releases.",
        code: `async ({ owner, repo }) => {
          const [meta, releases] = await Promise.all([
            repoApi.request({ operationId: "get_repository", params: { owner, repo } }),
            repoApi.request({ operationId: "list_releases", params: { owner, repo } }),
          ]);
          return { meta, releases };
        }`,
        instructions:
          "Combines metadata and release listing from the repoApi connector."
      }
    ];
  },
  async load(name) {
    const all = await this.list();
    return all.find((s) => s.name === name) ?? null;
  }
};
```

## How the model discovers and uses skills

Skills appear in `codemode.search` results alongside connector methods:

```ts
const matches = await codemode.search("pull request");
// Results include:
// { path: "github.list_pull_requests", kind: "method", ... }
// { path: "list-open-prs", kind: "skill", ... }
```

Skills are describable:

```ts
const docs = await codemode.describe("repo-overview");
// { path: "repo-overview", description: "...", types: "...", kind: "skill" }
```

Skills are executable via `codemode.run`:

```ts
const overview = await codemode.run("repo-overview", {
  owner: "cloudflare",
  repo: "agents"
});
```

## Skills vs connector methods

|            | Connector methods                  | Skills                             |
| ---------- | ---------------------------------- | ---------------------------------- |
| Defined by | Connector class                    | Skill source                       |
| Scope      | Single connector                   | Can combine multiple connectors    |
| Discovery  | `codemode.search` (kind: "method") | `codemode.search` (kind: "skill")  |
| Execution  | `connector.method(args)`           | `codemode.run("name", input)`      |
| State      | Session facet                      | No session — runs in sandbox       |
| Approval   | Via session annotations            | No approval — runs as sandbox code |

## Think integration

Think's skill system implements `CodemodeSkillSource`. When Think skills are loaded, they're available in the codemode sandbox:

```ts
// Think agent
getSkills() {
  return [bundledSkills];
}

// These same skills can be passed to codemode
createProxyTool({
  ctx: this.ctx,
  executor,
  connectors: [github],
  skills: [thinkSkillSource],
})
```
