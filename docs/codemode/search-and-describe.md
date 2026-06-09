# Search & Describe

The `codemode` platform SDK is available inside the sandbox as a global. It provides discovery and documentation for connector methods and saved snippets.

## `codemode.search(query)`

Ranked search across all connector methods and saved snippets.

```ts
const matches = await codemode.search("pull request");
```

Returns:

```ts
{
  results: [
    { path: "github.list_pull_requests", connector: "github", method: "list_pull_requests", description: "List pull requests.", kind: "method", score: 145 },
    { path: "list-open-prs", connector: "snippet", method: "list-open-prs", description: "List open PRs.", kind: "snippet", score: 120 },
  ],
  total: 2,
  truncated: false,
}
```

### How search works

Search uses Executor-style ranked matching:

1. **Normalize** — `camelCase`, `snake_case`, dots, paths, and colons are split into tokens. `listPullRequests` becomes `list pull requests`. `github.list_pull_requests` becomes `github list pull requests`.

2. **Tokenize** — query and fields are split into lowercase alphanumeric tokens.

3. **Score** — each field (path, connector, method, description) is scored by weight:
   - path: 12
   - connector: 8
   - method: 10
   - description: 5

4. **Coverage** — for queries with 1-2 tokens, all tokens must match. For longer queries, at least 60% of tokens must match (or the query must appear as an exact phrase).

5. **Bonuses** — exact match (+20), starts-with (+9), exact phrase (+6), leading token match (+8), full coverage (+25).

6. **Cap** — results are capped at 50. If truncated, the model should search with a more specific query.

### Examples

```ts
// Normalized matching — "pull request" matches "list_pull_requests"
codemode.search("pull request");

// Partial matching — "repo" matches both connectors
codemode.search("repo");

// Snippets appear alongside methods
codemode.search("overview");
```

## `codemode.describe(target)`

Get TypeScript documentation for a connector, method, or snippet.

### Describe a connector

```ts
const docs = await codemode.describe("github");
// {
//   path: "github",
//   description: "Use for GitHub operations.",
//   types: "declare const github: { list_pull_requests: ...; search_issues: ...; }",
//   kind: "connector"
// }
```

### Describe a method

```ts
const docs = await codemode.describe("github.list_pull_requests");
// {
//   path: "github.list_pull_requests",
//   description: "List pull requests for a repository.",
//   types: "type ListPullRequestsInput = { owner: string; repo: string; state?: string; }; ...",
//   kind: "method"
// }
```

### Describe a snippet

```ts
const docs = await codemode.describe("repo-overview");
// {
//   path: "repo-overview",
//   description: "Get combined repository metadata and releases.",
//   types: "async ({ owner, repo }) => { ... }",
//   kind: "snippet"
// }
```

## `codemode.run(name, input)`

Run a saved snippet by name. See [Snippets](./snippets.md).

```ts
const overview = await codemode.run("repo-overview", {
  owner: "cloudflare",
  repo: "agents"
});
```

## Types

```ts
type SearchResult = {
  path: string;
  connector: string;
  method: string;
  description?: string;
  kind: "method" | "snippet";
  score: number;
};

type SearchOutput = {
  results: SearchResult[];
  total: number;
  truncated: boolean;
};

type DescribeOutput = {
  path: string;
  description?: string;
  types: string;
  kind: "connector" | "method" | "snippet";
};
```
