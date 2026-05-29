# Codemode Connectors Example

This example shows how to build class-based codemode connectors that expose external services inside a sandboxed code execution environment.

The model gets one tool (`codemode`) that executes TypeScript. Inside the sandbox, connector SDKs and a platform discovery SDK are available as globals:

```ts
// discover
const matches = await codemode.search("pull request");
const docs = await codemode.describe("github.list_pull_requests");

// call
const prs = await github.list_pull_requests({ owner: "cloudflare", repo: "agents" });
const repo = await repoApi.request({ operationId: "get_repository", params: { owner: "cloudflare", repo: "agents" } });

// run a saved skill
const overview = await codemode.run("repo-overview", { owner: "cloudflare", repo: "agents" });
```

## What this example demonstrates

### Connectors

**`github.codemode.ts`** — an MCP connector that wraps a GitHub-like MCP server:

```ts
export class GithubConnector extends McpConnector<Env> {
  name() { return "github"; }
  protected instructions() { return "Use for GitHub operations."; }
  protected createConnection() { return this.conn; }
  protected annotations() {
    return {
      list_pull_requests: { observation: true },
      search_issues: { observation: true },
    };
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

### Skills

**`skills.ts`** — reusable code patterns that combine connector methods:

```ts
export const bundledSkills: CodemodeSkillSource = {
  id: "bundled",
  async list() { return skills; },
  async load(name) { return skills.find(s => s.name === name) ?? null; },
};
```

### Wiring

**`server.ts`** — the agent wires connectors and skills into `createProxyTool`:

```ts
tools: {
  codemode: createProxyTool({
    executor,
    connectors: [github, repoApi],
    skills: [bundledSkills],
  }),
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
- "Give me an overview of cloudflare/agents" (uses the `repo-overview` skill)
