import { tool } from "ai";
import { z } from "zod";
import type { WriteOperations } from "./types";

export interface WriteToolOptions {
  ops: WriteOperations;
}

export function createWriteTool(options: WriteToolOptions) {
  const { ops } = options;

  return tool({
    description:
      "Write content to a file. Creates the file if it does not exist, " +
      "overwrites if it does. Parent directories are created automatically.",
    inputSchema: z.object({
      path: z.string().describe("Absolute path to the file"),
      content: z.string().describe("Content to write to the file")
    }),
    execute: async ({ path, content }) => {
      // Ensure parent directory exists
      const parent = path.replace(/\/[^/]+$/, "");
      if (parent && parent !== "/") {
        ops.mkdir(parent, { recursive: true });
      }

      await ops.writeFile(path, content);

      const lines = content.split("\n").length;
      return {
        path,
        bytesWritten: new TextEncoder().encode(content).byteLength,
        lines
      };
    }
  });
}
