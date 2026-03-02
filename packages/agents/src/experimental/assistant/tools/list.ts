import { tool } from "ai";
import { z } from "zod";
import type { ListOperations } from "./types";

export interface ListToolOptions {
  ops: ListOperations;
}

export function createListTool(options: ListToolOptions) {
  const { ops } = options;

  return tool({
    description:
      "List files and directories in a given path. " +
      "Returns names, types, and sizes for each entry.",
    inputSchema: z.object({
      path: z
        .string()
        .default("/")
        .describe("Absolute path to the directory to list"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Maximum number of entries to return (default: 200)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of entries to skip (for pagination)")
    }),
    execute: async ({ path, limit, offset }) => {
      const maxEntries = limit ?? 200;
      const entries = ops.listFiles(path, {
        limit: maxEntries,
        offset: offset ?? 0
      });

      const formatted = entries.map((entry) => {
        const suffix = entry.type === "directory" ? "/" : "";
        const sizeStr =
          entry.type === "file" ? ` (${formatSize(entry.size)})` : "";
        return `${entry.name}${suffix}${sizeStr}`;
      });

      return {
        path,
        count: entries.length,
        entries: formatted
      };
    }
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
