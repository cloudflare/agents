import { tool } from "ai";
import { z } from "zod";
import type { DeleteOperations } from "./types";

export interface DeleteToolOptions {
  ops: DeleteOperations;
}

export function createDeleteTool(options: DeleteToolOptions) {
  const { ops } = options;

  return tool({
    description:
      "Delete a file or directory. " +
      "Set recursive to true to remove non-empty directories.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to the file or directory"),
      recursive: z
        .boolean()
        .optional()
        .describe("If true, remove directories and their contents recursively")
    }),
    execute: async ({ path, recursive }) => {
      await ops.rm(path, { recursive, force: true });
      return { deleted: path };
    }
  });
}
