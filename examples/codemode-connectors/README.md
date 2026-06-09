# Codemode Connectors Example

This example shows how to build class-based codemode connectors that expose external services inside a sandboxed code execution environment.

The model gets one tool (`codemode`) that executes TypeScript. Inside the sandbox, connector SDKs and a platform discovery SDK are available as globals:

```ts
// discover
const matches = await codemode.search("pull request");
const docs = await codemode.describe("github.list_pull_requests");

// call
const prs = await github.list_pull_requests({
  owner: "cloudflare",
  repo: "agents"
});
const spec = await repoApi.spec();
const repo = await repoApi.request({
  path: "/repos/{owner}/{repo}",
  params: { owner: "cloudflare", repo: "agents" }
});

// run a saved snippet
const overview = await codemode.run("repo-overview", {
  owner: "cloudflare",
  repo: "agents"
});
```

## What this example demonstrates

### Connectors

**`github.codemode.ts`** — an MCP connector that wraps a GitHub-like MCP server:

```ts
export class GithubConnector extends McpConnector<Env> {
  name() {
    return "github";
  }
  protected instructions() {
    return "Use for GitHub operations.";
  }
  protected createConnection() {
    return this.conn;
  }
}
```

**`repoapi.codemode.ts`** — an OpenAPI connector that wraps a REST API:

```ts
export class RepoApiConnector extends OpenApiConnector<Env> {
  name() { return "repoApi"; }
  protected spec() { return openapiSpec; }
  protected async request(input) { ... }
}
```

### Snippets

Once a script works, the developer can promote it to a reusable snippet (e.g. from a `@callable` wired to a UI button), and the model runs it again later:

```ts
// host side
await runtime.saveSnippet("repo-overview", {
  description: "Fetch repo metadata, open PRs, and latest releases."
});

// sandbox side (the model)
const overview = await codemode.run("repo-overview", {
  owner: "cloudflare",
  repo: "agents"
});
```

Snippets are stored durably on the runtime and surface in `codemode.search` and `codemode.describe` alongside connector methods.

### Wiring

**`server.ts`** — the agent wires connectors into a runtime and exposes `runtime.tool()`:

```ts
const runtime = createCodemodeRuntime({
  ctx,
  executor,
  connectors: [github, repoApi]
});

tools: {
  codemode: runtime.tool();
}
```

## Run locally

```sh
npm install
npm run start -w @cloudflare/agents-codemode-connectors-demo
```

Then try:

- "List open pull requests for cloudflare/agents"
- "Get repository metadata for cloudflare/agents"
- "Give me an overview of cloudflare/agents"
