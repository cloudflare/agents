/**
 * Pluggable interface for SQL execution.
 * When provided via ShellOptions.sql, enables the sqlite3 command.
 *
 * Workers: Use DOSqlExecutor from @cloudflare/shell/workers
 * Node.js: Wrap better-sqlite3
 * Browser: Wrap sql.js
 */
export interface SqlExecutor {
  query(sql: string): Promise<{ columns: string[]; values: unknown[][] }>;
  run(sql: string): Promise<{ changes: number }>;
  close?(): void;
}

/**
 * Pluggable interface for code execution in sandboxed environments.
 * When provided via ShellOptions.executor, enables js-exec/node/python3/python commands.
 *
 * Workers: Use DynamicIsolateExecutor from @cloudflare/shell/workers
 * Node.js: Wrap child_process
 */
export interface CodeExecutor {
  execute(
    code: string,
    language: "javascript" | "python",
    options?: { stdin?: string; env?: Record<string, string> }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/**
 * Pluggable interface for HTML-to-Markdown conversion.
 * When provided via ShellOptions.markdown, enables the html-to-markdown command.
 *
 * Workers: Use WorkersAIMarkdownConverter from @cloudflare/shell/workers
 * Node.js/Browser: Wrap turndown or similar
 */
export interface MarkdownConverter {
  convert(
    input: string | Uint8Array,
    options?: { url?: string; type?: string }
  ): Promise<string>;
}
