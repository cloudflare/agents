/**
 * sqlite3 command - Interface-backed SQL execution
 *
 * When a SqlExecutor is provided via ShellOptions.sql, this command
 * enables sqlite3-style SQL execution in the shell.
 */

import type { SqlExecutor } from "../../interfaces";
import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp } from "../help";

const sqlite3Help = {
  name: "sqlite3",
  summary: "execute SQL queries via pluggable SqlExecutor",
  usage: "sqlite3 [-header] [-csv|-json|-column|-line|-list] [SQL]",
  options: [
    "-header       show column headers",
    "-noheader     hide column headers",
    "-csv          CSV output",
    "-json         JSON output",
    "-column       column-aligned output",
    "-line          one value per line",
    "-list         values separated by separator (default: |)",
    "-separator S  set separator for list mode",
    "    --help    display this help and exit"
  ]
};

type OutputMode = "list" | "csv" | "json" | "column" | "line";

/**
 * Create a sqlite3 command backed by a SqlExecutor interface.
 */
export function createSqlite3Command(executor: SqlExecutor): Command {
  return {
    name: "sqlite3",
    async execute(args: string[], _ctx: CommandContext): Promise<ExecResult> {
      if (hasHelpFlag(args)) {
        return showHelp(sqlite3Help);
      }

      let mode: OutputMode = "list";
      let separator = "|";
      let showHeader = false;
      const sqlParts: string[] = [];

      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-header") {
          showHeader = true;
        } else if (arg === "-noheader") {
          showHeader = false;
        } else if (arg === "-csv") {
          mode = "csv";
          separator = ",";
          showHeader = true;
        } else if (arg === "-json") {
          mode = "json";
        } else if (arg === "-column") {
          mode = "column";
          showHeader = true;
        } else if (arg === "-line") {
          mode = "line";
        } else if (arg === "-list") {
          mode = "list";
        } else if (arg === "-separator" && i + 1 < args.length) {
          separator = args[++i];
        } else {
          sqlParts.push(arg);
        }
      }

      const sql = sqlParts.join(" ").trim();
      if (!sql) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      try {
        // Detect if it's a query or a statement
        const isQuery = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(sql);

        if (isQuery) {
          const result = await executor.query(sql);
          return {
            stdout: formatResult(result, mode, separator, showHeader),
            stderr: "",
            exitCode: 0
          };
        } else {
          const result = await executor.run(sql);
          return {
            stdout: result.changes > 0 ? `Changes: ${result.changes}\n` : "",
            stderr: "",
            exitCode: 0
          };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          stdout: "",
          stderr: `Error: ${msg}\n`,
          exitCode: 1
        };
      }
    }
  };
}

function formatResult(
  result: { columns: string[]; values: unknown[][] },
  mode: OutputMode,
  separator: string,
  showHeader: boolean
): string {
  const { columns, values } = result;
  if (values.length === 0 && !showHeader) return "";

  switch (mode) {
    case "json": {
      const rows = values.map((row) => {
        const obj: Record<string, unknown> = {};
        columns.forEach((col, i) => {
          obj[col] = row[i];
        });
        return obj;
      });
      return JSON.stringify(rows, null, 2) + "\n";
    }

    case "line": {
      const lines: string[] = [];
      for (const row of values) {
        for (let i = 0; i < columns.length; i++) {
          lines.push(`${columns[i]} = ${row[i] ?? ""}`);
        }
        lines.push("");
      }
      return lines.join("\n");
    }

    case "column": {
      const widths = columns.map((col) => col.length);
      for (const row of values) {
        for (let i = 0; i < row.length; i++) {
          widths[i] = Math.max(widths[i], String(row[i] ?? "").length);
        }
      }
      const lines: string[] = [];
      if (showHeader) {
        lines.push(columns.map((col, i) => col.padEnd(widths[i])).join("  "));
        lines.push(widths.map((w) => "-".repeat(w)).join("  "));
      }
      for (const row of values) {
        lines.push(
          row.map((val, i) => String(val ?? "").padEnd(widths[i])).join("  ")
        );
      }
      return lines.join("\n") + "\n";
    }

    case "csv":
    case "list":
    default: {
      const lines: string[] = [];
      if (showHeader) {
        lines.push(columns.join(separator));
      }
      for (const row of values) {
        lines.push(row.map((v) => String(v ?? "")).join(separator));
      }
      return lines.join("\n") + "\n";
    }
  }
}
