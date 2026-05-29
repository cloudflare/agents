import { McpConnector, type McpConnectionLike } from "@cloudflare/codemode";

/**
 * GitHub connector — backed by an MCP server.
 *
 * Exposes GitHub-like tools (list_pull_requests, search_issues) in the
 * codemode sandbox as `github.<method>(args)`.
 */
export class GithubConnector extends McpConnector<Env> {
  #conn?: McpConnectionLike;

  setConnection(conn: McpConnectionLike) {
    this.#conn = conn;
  }

  override name() {
    return "github";
  }

  protected override instructions() {
    return "Use for GitHub-style repository, issue, and pull request questions.";
  }

  protected override createConnection() {
    if (!this.#conn) throw new Error("MCP connection not set");
    return this.#conn;
  }

  override annotations() {
    return {
      list_pull_requests: { observation: true },
      search_issues: { observation: true }
    };
  }
}
