import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages, stepCountIs } from "ai";
import { routeAgentRequest } from "agents";

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
                  title: "Add MCP proxy tool",
                  state,
                  url: `https://github.com/${owner}/${repo}/pull/101`
                },
                {
                  number: 102,
                  title: "Document client-side MCP tools",
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
      {
        query: z.string().describe("Search query")
      },
      async ({ query }) => ({
        content: [
          {
            type: "text",
            text: `Search results for ${query}: #101 Add MCP proxy tool`
          }
        ]
      })
    );
  }
}

export class Chat extends AIChatAgent<Env> {
  async onStart() {
    await this.addMcpServer("github", this.env.GitHubLikeMCP, {
      instructions:
        "Use this server for GitHub-style repository, issue, and pull request questions. The client-side tools are curated shortcuts built on top of the raw MCP tools.",
      tools: {
        list_open_prs: {
          description:
            "List open pull requests for a repository. This is a client-side tool exposed by the proxy alongside raw MCP tools.",
          inputSchema: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                description: "Repository owner"
              },
              repo: {
                type: "string",
                description: "Repository name"
              }
            },
            required: ["owner", "repo"]
          },
          code: `async ({ owner, repo }) => {
            return await client.callTool({
              name: "list_pull_requests",
              arguments: {
                owner,
                repo,
                state: "open"
              }
            });
          }`
        }
      }
    });
  }

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are a helpful assistant. Use the single mcp proxy tool to discover available MCP servers and tools before answering integration questions. Try examples like mcp({ server: "github" }), mcp({ search: "pull request" }), and mcp({ describe: "github_list_open_prs" }). The current date and time is ${new Date().toISOString()}.`,
      messages: await convertToModelMessages(this.messages),
      tools: {
        mcp: this.mcp.unstable_getProxyTool()
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
