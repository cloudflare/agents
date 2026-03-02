import { tool } from "ai";
import { z } from "zod";
import type { FindOperations } from "./types";

export interface FindToolOptions {
  ops: FindOperations;
}

export function createFindTool(options: FindToolOptions) {
  const { ops } = options;

  return tool({
    description:
      "Find files matching a glob pattern. " +
      "Supports standard glob syntax: * matches any file, ** matches directories recursively, " +
      "? matches a single character. Returns matching file paths with types and sizes.",
    inputSchema: z.object({
      pattern: z
        .string()
        .describe(
          'Glob pattern to match (e.g. "**/*.ts", "src/**/*.test.ts", "*.md")'
        )
    }),
    execute: async ({ pattern }) => {
      const matches = ops.glob(pattern);

      const MAX_RESULTS = 200;
      const truncated = matches.length > MAX_RESULTS;
      const results = matches.slice(0, MAX_RESULTS);

      const formatted = results.map((entry) => {
        const suffix = entry.type === "directory" ? "/" : "";
        return `${entry.path}${suffix}`;
      });

      const result: Record<string, unknown> = {
        pattern,
        count: matches.length,
        files: formatted
      };

      if (truncated) {
        result.truncated = true;
        result.showing = MAX_RESULTS;
      }

      return result;
    }
  });
}
