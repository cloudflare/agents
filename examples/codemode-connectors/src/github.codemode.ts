import {
  McpConnector,
  type ConnectorTool,
  type McpConnectionLike
} from "@cloudflare/codemode";

/**
 * GitHub connector — backed by an MCP server.
 *
 * Exposes GitHub-like tools (list_pull_requests, search_issues, create_issue)
 * in the codemode sandbox as `github.<method>(args)`. MCP tools are reads by
 * default; the `tool()` hook marks the write (`create_issue`) as requiring
 * approval, so the run pauses for the user before it executes.
 */
export class GithubConnector extends McpConnector<Env> {
  // Inside a Durable Object `this.ctx` is a `DurableObjectState`. The connector
  // base accepts either it or an `ExecutionContext` — no cast needed.
  constructor(
    ctx: DurableObjectState | ExecutionContext,
    env: Env,
    private conn: McpConnectionLike
  ) {
    super(ctx, env);
  }

  override name() {
    return "github";
  }

  protected override instructions() {
    return "Use for GitHub-style repository, issue, and pull request questions.";
  }

  protected override createConnection() {
    return this.conn;
  }

  // Mark the write as approval-gated. The runtime pauses the run when the model
  // calls github.create_issue(...), and resumes once the user approves.
  protected override tool(name: string, t: ConnectorTool): ConnectorTool {
    if (name === "create_issue") {
      return { ...t, requiresApproval: true };
    }
    return t;
  }
}
