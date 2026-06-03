/**
 * Codemode snippets.
 *
 * A snippet is a saved sandbox script — a reusable code pattern that the model
 * has already written and verified. Snippets are durable: they live on the
 * CodemodeRuntime facet, are addressable by name, and accumulate over time as
 * the model promotes working code with `codemode.save(name)`.
 *
 * Connectors provide raw capability. Snippets are recipes the model learned.
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
}

/** Options when promoting the current execution to a saved snippet. */
export interface SaveSnippetOptions {
  description?: string;
  inputSchema?: unknown;
}
