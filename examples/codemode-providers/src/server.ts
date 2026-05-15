import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages, stepCountIs } from "ai";
import { routeAgentRequest } from "agents";
import {
  createProxyTool,
  DynamicWorkerExecutor,
  mcpProvider,
  openApiProvider
} from "@cloudflare/codemode";

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
                  title: "Add codemode snippets tool",
                  state,
                  url: `https://github.com/${owner}/${repo}/pull/101`
                },
                {
                  number: 102,
                  title: "Document codemode snippets",
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
            text: `Search results for ${query}: #101 Add codemode snippets tool`
          }
        ]
      })
    );
  }
}

const openapiSpec = {
  openapi: "3.1.0",
  info: { title: "Repository Metadata API", version: "1.0.0" },
  paths: {
    "/repos/{owner}/{repo}": {
      get: {
        operationId: "get_repository",
        summary: "Get repository metadata."
      }
    },
    "/repos/{owner}/{repo}/releases": {
      get: {
        operationId: "list_releases",
        summary: "List repository releases."
      }
    }
  }
};

export class Chat extends AIChatAgent<Env> {
  async onStart() {
    await this.addMcpServer("github", this.env.GitHubLikeMCP);
  }

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });

    const server = this.mcp.listServers().find((s) => s.name === "github");
    if (!server) throw new Error("GitHub MCP server is not registered.");
    const conn = this.mcp.mcpConnections[server.id];
    if (!conn) throw new Error("GitHub MCP connection is not available.");

    const github = mcpProvider({
      name: server.name,
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
              owner: { type: "string", description: "Repository owner" },
              repo: { type: "string", description: "Repository name" }
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
    });

    const repoApi = openApiProvider({
      name: "repoApi",
      spec: openapiSpec,
      instructions: "Use for repository metadata and release information.",
      request: async ({ operationId, params }) => {
        const p = params as { owner: string; repo: string };
        if (operationId === "get_repository") {
          return {
            fullName: `${p.owner}/${p.repo}`,
            stars: 1234,
            defaultBranch: "main",
            language: "TypeScript"
          };
        }
        return [
          { tag: "v0.12.4", name: "agents 0.12.4" },
          { tag: "@cloudflare/codemode@0.3.5", name: "codemode 0.3.5" }
        ];
      }
    });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are a helpful assistant. Use the codemode tool to discover available providers and run code against provider SDKs. Try examples like codemode({ search: "pull request" }), codemode({ describe: "github.list_open_prs" }), and codemode({ execute: "async () => await github.list_open_prs({ owner: 'cloudflare', repo: 'agents' })" }). The current date and time is ${new Date().toISOString()}.`,
      messages: await convertToModelMessages(this.messages),
      tools: {
        codemode: createProxyTool({
          executor,
          providers: [github, repoApi]
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
