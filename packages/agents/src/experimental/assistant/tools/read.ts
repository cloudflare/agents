import { tool } from "ai";
import { z } from "zod";
import type { ReadOperations } from "./types";

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

export interface ReadToolOptions {
  ops: ReadOperations;
}

export function createReadTool(options: ReadToolOptions) {
  const { ops } = options;

  return tool({
    description:
      "Read the contents of a file. Returns the file content with line numbers. " +
      "Use offset and limit for large files. Returns null if the file does not exist.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to the file"),
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-indexed line number to start reading from"),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Number of lines to read")
    }),
    execute: async ({ path, offset, limit }) => {
      const stat = ops.fileStat(path);
      if (!stat) {
        return { error: `File not found: ${path}` };
      }
      if (stat.type === "directory") {
        return { error: `${path} is a directory, not a file` };
      }

      const content = await ops.readFile(path);
      if (content === null) {
        return { error: `Could not read file: ${path}` };
      }

      const allLines = content.split("\n");
      const totalLines = allLines.length;

      // Apply offset/limit
      const startLine = offset ? offset - 1 : 0;
      const endLine = limit ? startLine + limit : allLines.length;
      const lines = allLines.slice(startLine, endLine);

      // Format with line numbers, truncate long lines
      const numbered = lines.map((line, i) => {
        const lineNum = startLine + i + 1;
        const truncated =
          line.length > MAX_LINE_LENGTH
            ? line.slice(0, MAX_LINE_LENGTH) + "... (truncated)"
            : line;
        return `${lineNum}\t${truncated}`;
      });

      // Truncate if too many lines
      let output: string;
      if (numbered.length > MAX_LINES) {
        output =
          numbered.slice(0, MAX_LINES).join("\n") +
          `\n... (${numbered.length - MAX_LINES} more lines truncated)`;
      } else {
        output = numbered.join("\n");
      }

      const result: Record<string, unknown> = {
        path,
        content: output,
        totalLines
      };

      if (offset || limit) {
        result.fromLine = startLine + 1;
        result.toLine = Math.min(endLine, totalLines);
      }

      return result;
    }
  });
}
