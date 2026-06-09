import { McpConnector, type McpConnectionLike } from "@cloudflare/codemode";

/**
 * GitHub connector — backed by an MCP server.
 *
 * Exposes GitHub-like tools (list_pull_requests, search_issues) in the
 * codemode sandbox as `github.<method>(args)`.
 */
export class GithubConnector extends McpConnector<Env> {
  constructor(
    ctx: ExecutionContext,
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
}
