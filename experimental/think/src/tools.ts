import { tool } from "ai";
import { z } from "zod";
import type { FileInfo, WorkspaceFacet } from "./workspace";

/**
 * The agent calls this tool to signal that it has finished its task.
 * It has no `execute` function — calling it terminates the agent loop.
 * The `summary` is displayed to the user as the final assistant message.
 */
export const DONE_TOOL_NAME = "done";

export const doneTool = tool({
  description:
    "Signal that you have completed the task. " +
    "Call this when you are done — provide a concise summary of what you did. " +
    "Do NOT call this while you still have work to do.",
  inputSchema: z.object({
    summary: z
      .string()
      .describe(
        "A brief summary of what was accomplished (1-3 sentences). " +
          "This is shown to the user as your final message."
      )
  })
  // No execute — calling this stops the agent loop (the SDK sees an
  // unexecuted tool call and terminates, matching hasToolCall('done')).
});

/**
 * Build the default set of filesystem tools backed by a Workspace facet.
 * Pass the result as `tools` to AgentLoop / Chat.streamInto options.
 *
 * Always includes the `done` tool so the agent can signal completion
 * with a structured summary rather than just stopping mid-stream.
 */
export function buildFileTools(workspace: WorkspaceFacet) {
  return {
    // ── File I/O ─────────────────────────────────────────────────────

    readFile: tool({
      description:
        "Read the contents of a file from the workspace. " +
        "Returns the file contents as a string, or an error if not found.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "Absolute path to the file (e.g. /src/index.ts). " +
              "All paths are rooted at / within the workspace."
          )
      }),
      execute: async ({ path }) => {
        console.log(`[tool:readFile] path=${path}`);
        try {
          const content = await workspace.readFile(path);
          if (content === null)
            return { error: `ENOENT: file not found: ${path}` };
          console.log(`[tool:readFile] ok, ${content.length} chars`);
          return { path, content };
        } catch (e) {
          console.error(`[tool:readFile] error:`, e);
          return { error: String(e) };
        }
      }
    }),

    writeFile: tool({
      description:
        "Write content to a file in the workspace. " +
        "Creates the file (and any missing parent directories) if it doesn't exist. " +
        "Overwrites the file if it does.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path to write to (e.g. /src/index.ts)."),
        content: z.string().describe("The full content to write to the file."),
        mimeType: z
          .string()
          .optional()
          .describe(
            "MIME type hint (default: text/plain). " +
              "Examples: text/x-typescript, text/x-python, application/json."
          )
      }),
      execute: async ({ path, content, mimeType }) => {
        console.log(`[tool:writeFile] path=${path} size=${content.length}`);
        try {
          await workspace.writeFile(path, content, mimeType);
          const bytes = new TextEncoder().encode(content).byteLength;
          console.log(`[tool:writeFile] ok, ${bytes} bytes`);
          return { path, bytesWritten: bytes };
        } catch (e) {
          console.error(`[tool:writeFile] error:`, e);
          return { error: String(e) };
        }
      }
    }),

    deleteFile: tool({
      description: "Delete a single file from the workspace.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path of the file to delete.")
      }),
      execute: async ({ path }) => {
        console.log(`[tool:deleteFile] path=${path}`);
        try {
          const deleted = await workspace.deleteFile(path);
          return { path, deleted };
        } catch (e) {
          console.error(`[tool:deleteFile] error:`, e);
          return { error: String(e) };
        }
      }
    }),

    fileExists: tool({
      description: "Check if a file exists in the workspace.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to check.")
      }),
      execute: async ({ path }) => {
        const exists = await workspace.fileExists(path);
        return { path, exists };
      }
    }),

    stat: tool({
      description:
        "Get metadata for a file or directory (type, size, timestamps). " +
        "Returns null if the path does not exist.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to inspect.")
      }),
      execute: async ({ path }): Promise<FileInfo | { error: string }> => {
        const info = await workspace.stat(path);
        if (!info)
          return { error: `ENOENT: no such file or directory: ${path}` };
        return info;
      }
    }),

    // ── Directory operations ──────────────────────────────────────────

    listFiles: tool({
      description:
        "List the direct contents of a directory (files and subdirectories). " +
        "Returns entries sorted: directories first, then files, both alphabetically. " +
        "Use stat() to check a specific path, or listFiles('/') to see the root.",
      inputSchema: z.object({
        dir: z
          .string()
          .optional()
          .describe(
            "Directory to list (default: / to list the workspace root). " +
              "Use /src to list the direct contents of /src."
          )
      }),
      execute: async ({ dir }) => {
        try {
          const entries = await workspace.listFiles(dir);
          return { dir: dir ?? "/", entries };
        } catch (e) {
          return { error: String(e) };
        }
      }
    }),

    mkdir: tool({
      description:
        "Create a directory in the workspace. " +
        "Use recursive: true to create all missing parent directories.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path of the directory to create."),
        recursive: z
          .boolean()
          .optional()
          .describe(
            "If true, create all missing parent directories (like mkdir -p). " +
              "If false (default), fails if the parent doesn't exist."
          )
      }),
      execute: async ({ path, recursive }) => {
        try {
          await workspace.mkdir(path, { recursive });
          return { path, created: true };
        } catch (e) {
          return { error: String(e) };
        }
      }
    }),

    rm: tool({
      description:
        "Remove a file or directory from the workspace. " +
        "Use recursive: true to remove a directory and all its contents. " +
        "Use force: true to silently ignore missing paths.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path of the file or directory to remove."),
        recursive: z
          .boolean()
          .optional()
          .describe(
            "If true, remove the directory and all its contents (like rm -r). " +
              "Required when removing a non-empty directory."
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "If true, silently ignore if the path does not exist (like rm -f)."
          )
      }),
      execute: async ({ path, recursive, force }) => {
        try {
          await workspace.rm(path, { recursive, force });
          return { path, removed: true };
        } catch (e) {
          return { error: String(e) };
        }
      }
    }),

    // ── Execution ─────────────────────────────────────────────────────

    bash: tool({
      description:
        "Execute a bash command in the workspace filesystem. " +
        "Supports pipes (|), redirects (>, >>), variables, loops, if/else, and " +
        "standard Unix commands: cat, grep, find, sed, awk, wc, sort, head, tail, " +
        "ls, cp, mv, mkdir, rm, touch, echo, etc. " +
        "All file reads and writes go to the persistent workspace filesystem. " +
        "The working directory starts at /. " +
        "Note: cwd and env vars do not persist between separate bash() calls.",
      inputSchema: z.object({
        command: z
          .string()
          .describe(
            "The bash command or script to execute. " +
              "Multi-line scripts are supported. " +
              "Example: 'find /src -name \"*.ts\" | xargs wc -l'"
          )
      }),
      execute: async ({ command }) => {
        console.log(`[tool:bash] command=${command.slice(0, 200)}`);
        try {
          const result = await workspace.bash(command);
          console.log(
            `[tool:bash] exit=${result.exitCode} stdout=${result.stdout.length} stderr=${result.stderr.length}`
          );
          return result;
        } catch (e) {
          console.error(`[tool:bash] error:`, e);
          return { stdout: "", stderr: String(e), exitCode: 1 };
        }
      }
    }),

    // ── Completion signal ─────────────────────────────────────────────

    [DONE_TOOL_NAME]: doneTool
  };
}
