# Codemode Connectors Example

This example shows how to build class-based codemode connectors that expose external services inside a sandboxed code execution environment.

The model gets one tool (`codemode`) that executes TypeScript. Inside the sandbox, connector SDKs and a platform discovery SDK are available as globals:

```ts
// discover
const matches = await codemode.search("pull request");
const docs = await codemode.describe("github.list_pull_requests");

// call connector methods directly
const prs = await github.list_pull_requests({
  owner: "cloudflare",
  repo: "agents"
});
const repo = await repoApi.get_repository({
  owner: "cloudflare",
  repo: "agents"
});

// approval-gated write — the run pauses here until the user approves
const issue = await github.create_issue({
  owner: "cloudflare",
  repo: "agents",
  title: "Docs typo"
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

**`repoapi.codemode.ts`** — an OpenAPI connector that wraps a REST API. The
base reads the spec once (host-side) and derives one typed tool per operation —
`repoApi.get_repository(...)`, `repoApi.list_releases(...)` — so the model never
has to read the raw spec or hand-build requests:

```ts
export class RepoApiConnector extends OpenApiConnector<Env> {
  name() { return "repoApi"; }
  protected spec() { return openapiSpec; }   // operations derived from this
  protected async request(input) { ... }      // performs the authenticated call
}
```

### Approvals

A connector marks a tool as approval-gated (here `github.create_issue`, via the
`tool()` hook). When the model calls it, the runtime records the action and
pauses the run. The agent exposes callable methods (`pendingApprovals`,
`approveExecution`, `rejectExecution`) that the UI wires to Approve / Reject
buttons. Approving re-runs the stored code, replaying everything up to the
approved action, runs it for real, and continues:

```ts
// host side (callable from the client — the @callable() decorator is required
// for agent.call() to reach these methods)
@callable() async pendingApprovals() { return this.#runtime().pending(); }
@callable() async approveExecution(id: string) { return this.#runtime().approve({ executionId: id }); }
@callable() async rejectExecution(id: string, seq: number) { await this.#runtime().reject({ seq, executionId: id }); }
```

Approving a run that is no longer paused (it completed, was rejected, or rolled back in another tab or a concurrent turn) is a safe no-op — it returns an error outcome and revives nothing, so a stale UI just refreshes the queue.

### Snippets

Once a script works, the developer can promote it to a reusable snippet (e.g. from a `@callable` wired to a UI button), and the model runs it again later:

```ts
// host side — executionId names the run whose code is promoted (from the tool
// output or runtime.executions())
await runtime.saveSnippet("repo-overview", {
  description: "Fetch repo metadata, open PRs, and latest releases.",
  executionId
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
- "Get repository metadata and latest releases for cloudflare/agents"
- "Open an issue titled 'Docs typo' on cloudflare/agents" — then Approve it in the panel
