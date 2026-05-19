# Codemode Providers Example

This example shows how to expose MCP server capabilities through codemode-style provider tools:

```ts
tools: {
  (search, describe, execute);
}
```

The model progressively discovers capabilities without putting every MCP tool directly into model context:

```ts
search({ query: "pull request" });
describe({ tool: "github.list_open_prs" });
execute({
  code: `async () => {
    return await github.list_open_prs({
      owner: "cloudflare",
      repo: "agents"
    });
  }`
});
```

## What this example demonstrates

`src/server.ts` defines:

- `GitHubLikeMCP` — a small MCP server with raw tools:
  - `list_pull_requests`
  - `search_issues`
- `Chat` — an `AIChatAgent` that connects to that MCP server and exposes `search`, `describe`, and `execute`.

The chat agent creates a codemode MCP provider from the existing MCP connection:

```ts
const server = this.mcp.listServers().find((s) => s.name === "github");
const conn = server ? this.mcp.mcpConnections[server.id] : undefined;

const github = conn
  ? mcpProvider({
      name: "github",
      connection: conn,
      executor,
      instructions:
        "Use for GitHub-style repository, issue, and pull request questions.",
      snippets: {
        list_open_prs: {
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
            return await github.list_pull_requests({
              owner,
              repo,
              state: "open"
            });
          }`
        }
      }
    })
  : undefined;
```

The important shape is:

```ts
mcpProvider({
  name: server.name,
  connection: conn,
  instructions,
  snippets
});
```

`connection` is the existing `MCPClientConnection`; the provider does not receive the whole MCP manager.

## Snippets

Snippets are provider-local code helpers. They are not remote MCP tools, but they are callable through the same generated provider SDK.

Remote MCP tool:

```ts
github.list_pull_requests({ owner, repo, state: "open" });
```

Snippet built on top of it:

```ts
github.list_open_prs({ owner, repo });
```

Snippet implementation:

```ts
async ({ owner, repo }) => {
  return await github.list_pull_requests({
    owner,
    repo,
    state: "open"
  });
};
```

## Run locally

```sh
npm install
npm run start -w @cloudflare/agents-codemode-providers-demo
```

Then ask the chat UI things like:

- "Search tools for pull request"
- "Describe github.list_open_prs"
- "Use execute to list open PRs for cloudflare/agents"
- "Search the github provider"
