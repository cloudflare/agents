import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages, stepCountIs } from "ai";
import { routeAgentRequest, callable } from "agents";
import {
  createCodemodeRuntime,
  DynamicWorkerExecutor,
  type CodemodeRuntimeHandle,
  type PendingAction,
  type ExecutionState,
  type Snippet
} from "@cloudflare/codemode";
import { BrowserConnector, DurableBrowserSessionStore } from "agents/browser";
import { GithubConnector } from "./github.codemode" with { type: "connectors" };
import { RepoApiConnector } from "./repoapi.codemode" with { type: "connectors" };

// ---------------------------------------------------------------------------
// Demo MCP server — a couple of reads and one approval-gated write.
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

    this.server.tool(
      "create_issue",
      "Create a new issue (write — requires approval).",
      {
        owner: z.string(),
        repo: z.string(),
        title: z.string(),
        body: z.string().optional()
      },
      async ({ owner, repo, title }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              number: 103,
              title,
              url: `https://github.com/${owner}/${repo}/issues/103`
            })
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

  /**
   * Build the codemode runtime for this agent. Connectors are constructed
   * in-process (note: no `ExecutionContext` cast — the connector base accepts
   * `this.ctx`). The runtime is shared between the chat tool and the callable
   * approval/snippet methods below; its identity is its name, so connectors
   * can be added without forking executions or snippets.
   */
  #runtime(): CodemodeRuntimeHandle {
    const server = this.mcp.listServers().find((s) => s.name === "github");
    if (!server) throw new Error("GitHub MCP server is not registered.");
    const conn = this.mcp.mcpConnections[server.id];
    if (!conn) throw new Error("GitHub MCP connection is not available.");

    const github = new GithubConnector(this.ctx, this.env, conn);
    const repoApi = new RepoApiConnector(this.ctx, this.env);

    // Live browser over the Chrome DevTools Protocol. Sessions are one-shot
    // per execution by default; the model can call cdp.startSession() to
    // keep one alive across executions (dynamic mode).
    const browser = new BrowserConnector(this.ctx, {
      browser: this.env.BROWSER,
      store: new DurableBrowserSessionStore(this.ctx.storage),
      session: { mode: "dynamic" }
    });

    return createCodemodeRuntime({
      ctx: this.ctx,
      executor: new DynamicWorkerExecutor({ loader: this.env.LOADER }),
      connectors: [github, repoApi, browser]
    });
  }

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: [
        "You are a helpful assistant with a `codemode` tool that runs TypeScript.",
        "Inside the sandbox:",
        '  - await codemode.search("query") to discover connector methods and saved snippets',
        '  - await codemode.describe("connector.method") for TypeScript docs',
        "  - await <connector>.<method>(args) to call a method directly",
        '  - await codemode.run("name", input) to run a saved snippet',
        "Connectors: `github` (pull requests, issues), `repoApi` (repo metadata, releases), and `cdp` (a live browser over the Chrome DevTools Protocol — cdp.send, cdp.attachToTarget, cdp.spec).",
        "Some actions (like github.create_issue) require approval — the run pauses and resumes after the user approves. Write code as if the call returns normally.",
        "",
        `The current date and time is ${new Date().toISOString()}.`
      ].join("\n"),
      messages: await convertToModelMessages(this.messages),
      tools: {
        codemode: this.#runtime().tool()
      },
      stopWhen: stepCountIs(10)
    });

    return result.toUIMessageStreamResponse();
  }

  // ---- Callable methods for the approval / snippet UI -----------------------

  /** Actions awaiting approval across paused executions. */
  @callable()
  async pendingApprovals(): Promise<PendingAction[]> {
    return this.#runtime().pending();
  }

  /** Approve a paused execution and resume it; returns the resumed outcome. */
  @callable()
  async approveExecution(executionId: string) {
    return this.#runtime().approve({ executionId });
  }

  /** Reject a pending action, ending the execution. */
  @callable()
  async rejectExecution(executionId: string, seq: number): Promise<void> {
    await this.#runtime().reject({ seq, executionId });
  }

  /** Roll back an execution's applied, reversible actions. */
  @callable()
  async rollbackExecution(executionId: string): Promise<void> {
    await this.#runtime().rollback({ executionId });
  }

  /** The audit trail, newest first. */
  @callable()
  async executions(): Promise<ExecutionState[]> {
    return this.#runtime().executions(20);
  }

  /** Promote a completed execution's script into a reusable snippet. */
  @callable()
  async saveSnippet(
    name: string,
    description: string,
    executionId: string
  ): Promise<Snippet> {
    return this.#runtime().saveSnippet(name, { description, executionId });
  }

  /** Saved snippets, surfaced to the model in search/describe. */
  @callable()
  async snippets(): Promise<Snippet[]> {
    return this.#runtime().snippets();
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
