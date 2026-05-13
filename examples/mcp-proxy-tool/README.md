# MCP Proxy Tool Example

This example shows how to expose MCP server capabilities through one model-facing proxy tool:

```ts
tools: {
  mcp: this.mcp.unstable_getProxyTool()
}
```

The proxy supports progressive discovery without putting every MCP tool in the model context:

```ts
mcp({})
mcp({ server: "github" })
mcp({ search: "pull request" })
mcp({ describe: "github_list_open_prs" })
mcp({ tool: "github_list_open_prs", args: { owner: "cloudflare", repo: "agents" } })
```

## What this example demonstrates

`src/server.ts` defines:

- `GitHubLikeMCP` — a small MCP server with raw tools:
  - `list_pull_requests`
  - `search_issues`
- `Chat` — an `AIChatAgent` that connects to that MCP server and exposes only the single proxy tool to the model.

The agent registers developer-provided instructions and client-side tools when adding the MCP server:

```ts
await this.addMcpServer("github", this.env.GitHubLikeMCP, {
  instructions:
    "Use this server for GitHub-style repository, issue, and pull request questions.",
  tools: {
    list_open_prs: {
      description:
        "List open pull requests for a repository. This is a client-side tool exposed by the proxy alongside raw MCP tools.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" }
        },
        required: ["owner", "repo"]
      },
      code: `async ({ owner, repo }) => {
        return await server.callTool("list_pull_requests", {
          owner,
          repo,
          state: "open"
        });
      }`
    }
  }
});
```

The client-side tool `list_open_prs` appears through the proxy just like a normal MCP tool.

Exact proxy results for this shape look like:

```txt
mcp({})

MCP: 1 server, 2 tools

✓ github (2 tools)

Use mcp({ server: "name" }) to list tools, mcp({ search: "..." }) to search.
```

```txt
mcp({ server: "github" })

github
State: ready
Tools: 2

Instructions: Use this server for GitHub-style repository, issue, and pull request questions.

Tools:
- github_list_pull_requests — List pull requests for a repository.
- github_list_open_prs — List open pull requests for a repository. This is a client-side tool exposed by the proxy alongside raw MCP tools.
```

```txt
mcp({ search: "open pull requests" })

Found 1 tool matching "open pull requests":

github_list_open_prs — List open pull requests for a repository. This is a client-side tool exposed by the proxy alongside raw MCP tools.
  owner (string) *required*
  repo (string) *required*
```

```txt
mcp({ describe: "github_list_open_prs" })

github_list_open_prs
Server: github

List open pull requests for a repository. This is a client-side tool exposed by the proxy alongside raw MCP tools.

Parameters:
  owner (string) *required*
  repo (string) *required*
```

```ts
await mcp({
  tool: "github_list_open_prs",
  args: { owner: "cloudflare", repo: "agents" }
});
```

## Run locally

```sh
npm install
npm run start -w @cloudflare/agents-mcp-proxy-tool-demo
```

Then ask the chat UI things like:

- "What MCP servers are available?"
- "Search MCP tools for pull request"
- "Describe github_list_open_prs"
- "Show me the github server tools"
