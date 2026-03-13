/**
 * Node.js Adapters
 *
 * Ready-made implementations of the pluggable interfaces for
 * use in Node.js environments. Import from "@cloudflare/shell/node".
 *
 * @example
 * ```ts
 * import { Shell } from "@cloudflare/shell";
 * import { BetterSqlite3Executor, ChildProcessExecutor, TurndownConverter } from "@cloudflare/shell/node";
 *
 * const shell = new Shell({
 *   sql: new BetterSqlite3Executor(":memory:"),
 *   executor: new ChildProcessExecutor(),
 *   markdown: new TurndownConverter(),
 * });
 * ```
 */

import { execFile } from "node:child_process";
import type {
  SqlExecutor,
  CodeExecutor,
  MarkdownConverter
} from "./interfaces";

// ── BetterSqlite3Executor ─────────────────────────────────────────
//
// Wraps a better-sqlite3 Database instance to implement SqlExecutor.
// Users must install better-sqlite3 as a peer dependency.

/**
 * The subset of better-sqlite3's Database API we need.
 * This avoids requiring better-sqlite3 as a direct dependency.
 */
export interface BetterSqlite3Like {
  prepare(sql: string): BetterSqlite3StatementLike;
  close(): void;
}

export interface BetterSqlite3StatementLike {
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number };
  columns(): { name: string }[];
}

/**
 * Implements SqlExecutor using better-sqlite3.
 *
 * @example
 * ```ts
 * import Database from "better-sqlite3";
 * import { BetterSqlite3Executor } from "@cloudflare/shell/node";
 *
 * const db = new Database(":memory:");
 * const sql = new BetterSqlite3Executor(db);
 * const shell = new Shell({ sql });
 * ```
 */
export class BetterSqlite3Executor implements SqlExecutor {
  constructor(private readonly db: BetterSqlite3Like) {}

  async query(
    sql: string
  ): Promise<{ columns: string[]; values: unknown[][] }> {
    const stmt = this.db.prepare(sql);
    const columns = stmt.columns().map((c) => c.name);
    const rows = stmt.all();
    const values = rows.map((row) => columns.map((col) => row[col]));
    return { columns, values };
  }

  async run(sql: string): Promise<{ changes: number }> {
    const stmt = this.db.prepare(sql);
    const result = stmt.run();
    return { changes: result.changes };
  }

  close(): void {
    this.db.close();
  }
}

// ── ChildProcessExecutor ──────────────────────────────────────────
//
// Uses Node.js child_process to execute JavaScript and Python code.

/**
 * Implements CodeExecutor using Node.js child_process.
 *
 * Spawns `node -e` for JavaScript and `python3 -c` for Python.
 *
 * @example
 * ```ts
 * import { ChildProcessExecutor } from "@cloudflare/shell/node";
 *
 * const executor = new ChildProcessExecutor();
 * const shell = new Shell({ executor });
 * await shell.exec('js-exec "console.log(1+1)"');
 * ```
 */
export class ChildProcessExecutor implements CodeExecutor {
  private readonly nodeBin: string;
  private readonly pythonBin: string;
  private readonly timeout: number;

  constructor(options?: {
    nodeBin?: string;
    pythonBin?: string;
    timeout?: number;
  }) {
    this.nodeBin = options?.nodeBin ?? "node";
    this.pythonBin = options?.pythonBin ?? "python3";
    this.timeout = options?.timeout ?? 30_000;
  }

  execute(
    code: string,
    language: "javascript" | "python",
    options?: { stdin?: string; env?: Record<string, string> }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const [bin, args] =
      language === "javascript"
        ? [this.nodeBin, ["-e", code]]
        : [this.pythonBin, ["-c", code]];

    return new Promise((resolve) => {
      // Merge shell env on top of process.env, but always keep the
      // real system PATH so that node/python3 binaries can be found.
      const env = options?.env
        ? { ...process.env, ...options.env }
        : { ...process.env };
      if (process.env.PATH) {
        env.PATH = process.env.PATH;
      }

      const child = execFile(
        bin,
        args,
        {
          timeout: this.timeout,
          env,
          maxBuffer: 10 * 1024 * 1024
        },
        (error, stdout, stderr) => {
          const exitCode =
            error && "code" in error && typeof error.code === "number"
              ? error.code
              : error
                ? 1
                : 0;
          resolve({ stdout, stderr, exitCode });
        }
      );

      if (options?.stdin && child.stdin) {
        child.stdin.write(options.stdin);
        child.stdin.end();
      }
    });
  }
}

// ── TurndownConverter ─────────────────────────────────────────────
//
// Uses the turndown npm package for HTML-to-Markdown conversion.
// Users must install turndown as a peer dependency.

/**
 * The subset of turndown's TurndownService API we need.
 * This avoids requiring turndown as a direct dependency.
 */
export interface TurndownServiceLike {
  turndown(html: string): string;
}

/**
 * Factory function that creates a TurndownServiceLike instance.
 * Users can provide their own factory with custom turndown options.
 */
export type TurndownFactory = () => TurndownServiceLike;

/**
 * Implements MarkdownConverter using turndown.
 *
 * @example
 * ```ts
 * import TurndownService from "turndown";
 * import { TurndownConverter } from "@cloudflare/shell/node";
 *
 * const markdown = new TurndownConverter(() => new TurndownService());
 * const shell = new Shell({ markdown });
 * await shell.exec('echo "<h1>Hi</h1>" | html-to-markdown');
 * ```
 */
export class TurndownConverter implements MarkdownConverter {
  private readonly factory: TurndownFactory;

  constructor(factory: TurndownFactory) {
    this.factory = factory;
  }

  async convert(
    input: string | Uint8Array,
    _options?: { url?: string; type?: string }
  ): Promise<string> {
    const html =
      typeof input === "string" ? input : new TextDecoder().decode(input);

    const service = this.factory();
    return service.turndown(html);
  }
}

// Re-export interfaces for convenience
export type { SqlExecutor, CodeExecutor, MarkdownConverter };
