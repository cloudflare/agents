/**
 * ParentRPC - RPC client for subagent facets to access parent's tools
 *
 * ARCHITECTURE:
 * Facets run in separate isolates but CAN call back to their parent via:
 * 1. ctx.exports.Think - the DO namespace
 * 2. namespace.get(doId) - get a stub to the parent
 * 3. stub.fetch(request) - make HTTP requests to parent's endpoints
 *
 * This was verified by E2E test: Facets can successfully call parent.fetch()
 * and get responses from the parent's HTTP endpoints.
 *
 * Usage in Subagent:
 *   const rpc = new ParentRPC(this.ctx, parentDOId);
 *   const content = await rpc.readFile("main.ts");
 *   const bashResult = await rpc.bash("echo hello");
 */

import type { BashResult } from "./bash";
import type { FetchResult, FetchError } from "./fetch";

/**
 * Parent RPC client for making HTTP calls to the parent DO
 */
export class ParentRPC {
  private parentStub: {
    fetch: (request: Request) => Promise<Response>;
  } | null = null;

  constructor(
    // oxlint-disable-next-line no-explicit-any -- DurableObjectState.exports is untyped
    private ctx: { exports: any },
    private parentDOId: string
  ) {}

  /**
   * Get the parent DO stub (lazily initialized)
   */
  private getParentStub(): {
    fetch: (request: Request) => Promise<Response>;
  } {
    if (!this.parentStub) {
      const exports = this.ctx.exports;
      if (!exports || !exports.Think) {
        throw new Error("Think DO namespace not available in ctx.exports");
      }

      const thinkNamespace = exports.Think;
      const doId = thinkNamespace.idFromString(this.parentDOId);
      this.parentStub = thinkNamespace.get(doId) as {
        fetch: (request: Request) => Promise<Response>;
      };
    }
    return this.parentStub;
  }

  /**
   * Make an HTTP request to the parent DO
   */
  private async request(
    path: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const stub = this.getParentStub();
    // The URL doesn't matter for DO stubs, only the path is used
    const url = `http://parent${path}`;
    return stub.fetch(new Request(url, options));
  }

  // ==========================================================================
  // File Operations
  // ==========================================================================

  /**
   * Read a file from the parent's YjsStorage
   *
   * @param path - The file path
   * @returns File content or null if not found
   */
  async readFile(path: string): Promise<string | null> {
    const response = await this.request(`/file/${encodeURIComponent(path)}`);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to read file: ${error}`);
    }
    const data = (await response.json()) as { content: string };
    return data.content;
  }

  /**
   * Write a file to the parent's YjsStorage
   *
   * @param path - The file path
   * @param content - The file content
   */
  async writeFile(path: string, content: string): Promise<void> {
    const response = await this.request(`/file/${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to write file: ${error}`);
    }
  }

  /**
   * Delete a file from the parent's YjsStorage
   *
   * @param path - The file path
   * @returns True if deleted, false if not found
   */
  async deleteFile(path: string): Promise<boolean> {
    const response = await this.request(`/file/${encodeURIComponent(path)}`, {
      method: "DELETE"
    });
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to delete file: ${error}`);
    }
    return true;
  }

  /**
   * List all files
   *
   * @returns Array of file paths
   */
  async listFiles(): Promise<string[]> {
    const response = await this.request("/files");
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list files: ${error}`);
    }
    const data = (await response.json()) as {
      files: Record<string, string>;
    };
    return Object.keys(data.files);
  }

  /**
   * Get all files with content
   *
   * @returns Object mapping path to content
   */
  async getFiles(): Promise<Record<string, string>> {
    const response = await this.request("/files");
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get files: ${error}`);
    }
    const data = (await response.json()) as {
      files: Record<string, string>;
    };
    return data.files;
  }

  // ==========================================================================
  // Bash Operations
  // ==========================================================================

  /**
   * Execute a bash command via the parent
   *
   * @param command - The bash command to execute
   * @param options - Optional execution options
   * @returns BashResult with stdout, stderr, exitCode
   */
  async bash(
    command: string,
    options?: { cwd?: string; env?: Record<string, string> }
  ): Promise<BashResult> {
    const response = await this.request("/rpc/bash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, options })
    });
    if (!response.ok) {
      const error = await response.text();
      return {
        stdout: "",
        stderr: `RPC error: ${error}`,
        exitCode: 1
      };
    }
    return (await response.json()) as BashResult;
  }

  // ==========================================================================
  // Fetch Operations
  // ==========================================================================

  /**
   * Make an HTTP request via the parent's FetchLoopback
   *
   * @param url - The URL to fetch
   * @param options - Request options
   * @returns FetchResult or FetchError
   */
  async fetch(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<FetchResult | FetchError> {
    const response = await this.request("/rpc/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, ...options })
    });
    if (!response.ok) {
      const error = await response.text();
      return {
        error: `RPC error: ${error}`,
        code: "FETCH_FAILED" as const,
        url
      };
    }
    return (await response.json()) as FetchResult | FetchError;
  }

  // ==========================================================================
  // Search Operations
  // ==========================================================================

  /**
   * Perform a web search via the parent's BraveSearchLoopback
   *
   * @param query - The search query
   * @returns Search results
   */
  async webSearch(query: string): Promise<{
    results: Array<{ title: string; url: string; snippet: string }>;
  }> {
    const response = await this.request("/rpc/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Search failed: ${error}`);
    }
    return (await response.json()) as {
      results: Array<{ title: string; url: string; snippet: string }>;
    };
  }
}
