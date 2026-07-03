import { tool } from "ai";
import { z } from "zod";
import type { FileStore } from "../stores/types";
import { withFileLock } from "../file-lock";

export interface WriteToolOptions {
  store: FileStore;
  /**
   * Reject writes whose UTF-8 byte length exceeds this cap. The model is
   * pointed at the edit tool instead. Default 2 MiB.
   */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const inputSchema = z.object({
  path: z.string().describe("Absolute path, e.g. /workspace/main.zig"),
  content: z.string().describe("File content")
});

export function createWriteTool(options: WriteToolOptions) {
  const { store } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return tool({
    description:
      "Write content to a file. Overwrites any existing file at the path. " +
      "Parent directories are created automatically.",
    inputSchema,
    execute: async ({ path, content }) => {
      const bytes = new TextEncoder().encode(content);
      if (bytes.length > maxBytes) {
        return {
          error: `Content too large: ${bytes.length} bytes exceeds the ${maxBytes}-byte write cap. Use the edit tool for incremental changes to existing files, or split the write into smaller pieces.`
        };
      }
      // Preserve the existing file's mode when overwriting so executable
      // scripts don't silently lose their +x bit. For new files we leave
      // `mode` undefined and let the store apply its own default. Runs under
      // the shared per-file lock so a concurrent edit's read-modify-write on
      // the same path cannot interleave with this stat-then-write.
      return withFileLock(path, async () => {
        const existing = await store.stat(path);
        await store.write(
          path,
          bytes,
          existing ? { mode: existing.mode } : undefined
        );
        return { path, bytesWritten: bytes.length };
      });
    }
  });
}
