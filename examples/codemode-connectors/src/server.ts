import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages, stepCountIs } from "ai";
import { routeAgentRequest } from "agents";
import { createProxyTool, DynamicWorkerExecutor } from "@cloudflare/codemode";
import { GithubConnector } from "./github.codemode" with { type: "connectors" };
import { RepoApiConnector } from "./repoapi.codemode" with { type: "connectors" };
import { bundledSkills } from "./skills";

// ---------------------------------------------------------------------------
// Demo MCP server
// ---------------------------------------------------------------------------

export class GitHubLikeMCP extends McpAgent<Env> {
  server = new McpServer({ name: "GitHub-like Demo", version: "1.0.0" });

  async init() {
    this.server.tool(
      "list_pull_requests",
      "List pull requests for a repository.",
      {
        owner: z.string().describe("Repository owner"),
        repo: z.string().describe("Repository name"),
        state: z.enum(["open", "closed", "all"]).default("open")
      },
      async ({ owner, repo, state }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              [
                {
                  number: 101,
                  title: "Add codemode connectors",
                  state,
                  url: `https://github.com/${owner}/${repo}/pull/101`
                },
                {
                  number: 102,
                  title: "Document codemode",
                  state,
                  url: `https://github.com/${owner}/${repo}/pull/102`
                }
              ],
              null,
              2
            )
          }
        ]
      })
    );

    this.server.tool(
      "search_issues",
      "Search issues and pull requests.",
      { query: z.string().describe("Search query") },
      async ({ query }) => ({
        content: [
          {
            type: "text",
            text: `Search results for ${query}: #101 Add codemode connectors`
          }
        ]
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Chat agent
// ---------------------------------------------------------------------------

export class Chat extends AIChatAgent<Env> {
  async onStart() {
    await this.addMcpServer("github", this.env.GitHubLikeMCP);
  }

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });

    // Get MCP connection
    const server = this.mcp.listServers().find((s) => s.name === "github");
    if (!server) throw new Error("GitHub MCP server is not registered.");
    const conn = this.mcp.mcpConnections[server.id];
    if (!conn) throw new Error("GitHub MCP connection is not available.");

    // Create connectors
    // Connectors are WorkerEntrypoints — instantiate with ctx/env
    const github = new GithubConnector(this.ctx as any, this.env);
    github.setConnection(conn);
    const repoApi = new RepoApiConnector(this.ctx as any, this.env);

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: [
        "You are a helpful assistant.",
        "Use the codemode tool to discover and call connector SDKs.",
        "Inside code:",
        '  - await codemode.search("query") to discover methods and skills',
        '  - await codemode.describe("connector.method") for TypeScript docs',
        '  - await codemode.run("skill-name", input) to run a reusable skill',
        "  - await <connector>.<method>(args) to call methods directly",
        "  - await codemode.pending() to check pending approvals",
        "",
        `The current date and time is ${new Date().toISOString()}.`
      ].join("\n"),
      messages: await convertToModelMessages(this.messages),
      tools: {
        codemode: createProxyTool({
          ctx: this.ctx,
          executor,
          connectors: [github, repoApi],
          skills: [bundledSkills]
        })
      },
      stopWhen: stepCountIs(10)
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/mcp")) {
      return GitHubLikeMCP.serve("/mcp", { binding: "GitHubLikeMCP" }).fetch(
        request,
        env,
        ctx
      );
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
