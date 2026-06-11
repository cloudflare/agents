/**
 * Codemode snippets.
 *
 * A snippet is a saved sandbox script — a reusable code pattern that already
 * ran and worked. Snippets are durable: they live on the CodemodeRuntime
 * facet, are addressable by name, and accumulate over time as the developer
 * promotes working executions with `runtime.saveSnippet(name)`.
 *
 * Connectors provide raw capability. Snippets are recipes that worked. The
 * model reuses them (`codemode.run`, `codemode.search`); the developer decides
 * what is worth keeping.
 */

/** A saved, addressable sandbox script. */
export interface Snippet {
  /** Unique name. Appears in codemode.search and addresses codemode.run. */
  name: string;
  /** Short description for search/catalog. */
  description: string;
  /** The script — an async function source string, as written in the sandbox. */
  code: string;
  /** When the snippet was saved (epoch ms). */
  savedAt: number;
  /** Optional JSON Schema for the input passed to codemode.run(name, input). */
  inputSchema?: unknown;
  /**
   * Connector names the source execution ran with. Recorded so a later
   * `codemode.run` can verify the required connectors are still configured on
   * the runtime, with a clear error when one is missing.
   */
  connectors?: string[];
}

/** Options when promoting an execution's script to a saved snippet. */
export interface SaveSnippetOptions {
  description?: string;
  inputSchema?: unknown;
  /** Execution to take the code from (from the tool output or listExecutions). */
  executionId: string;
}
