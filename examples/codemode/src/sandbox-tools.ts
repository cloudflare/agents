import { tool } from "ai";
import { z } from "zod";
import type { ToolProvider } from "@cloudflare/codemode";

/**
 * Minimal interface for the Sandbox SDK.
 * Avoids a hard dependency on @cloudflare/sandbox — any object
 * that matches these signatures works.
 */
export interface SandboxLike {
  exec(
    command: string,
    options?: {
      timeoutMs?: number;
      env?: Record<string, string>;
      cwd?: string;
    }
  ): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;

  readFile(path: string): Promise<{ content: string }>;

  writeFile(
    path: string,
    content: string
  ): Promise<{ success: boolean; path: string }>;

  listFiles(
    path: string,
    options?: { recursive?: boolean }
  ): Promise<{
    files: Array<{
      name: string;
      path: string;
      isDirectory: boolean;
      size: number;
    }>;
    count: number;
  }>;

  deleteFile(path: string): Promise<{ success: boolean }>;

  startProcess(
    command: string,
    options?: { cwd?: string }
  ): Promise<{ processId: string; command: string }>;

  killProcess(processId: string): Promise<{ success: boolean }>;

  listProcesses(): Promise<{
    processes: Array<{
      processId: string;
      command: string;
      status: string;
    }>;
  }>;
}

/**
 * Create a codemode ToolProvider that exposes Sandbox SDK methods.
 *
 * Returns a named provider ("sandbox") so the LLM calls:
 *   sandbox.exec("ls")
 *   sandbox.readFile("/workspace/file.txt")
 *   sandbox.writeFile("/workspace/out.txt", content)
 */
export function sandboxTools(sandbox: SandboxLike): ToolProvider {
  const tools = {
    exec: tool({
      description: "Execute a shell command",
      inputSchema: z.object({
        command: z.string().describe("Shell command to execute"),
        cwd: z.string().optional().describe("Working directory"),
        timeoutMs: z.number().optional().describe("Timeout in milliseconds"),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variables")
      }),
      execute: async ({ command, cwd, timeoutMs, env }) => {
        return sandbox.exec(command, { cwd, timeoutMs, env });
      }
    }),

    readFile: tool({
      description: "Read a file's contents",
      inputSchema: z.object({
        path: z.string().describe("Absolute file path to read")
      }),
      execute: async ({ path }) => {
        return sandbox.readFile(path);
      }
    }),

    writeFile: tool({
      description: "Write content to a file (creates or overwrites)",
      inputSchema: z.object({
        path: z.string().describe("Absolute file path to write"),
        content: z.string().describe("File content")
      }),
      execute: async ({ path, content }) => {
        return sandbox.writeFile(path, content);
      }
    }),

    listFiles: tool({
      description: "List files in a directory",
      inputSchema: z.object({
        path: z.string().describe("Directory path to list"),
        recursive: z
          .boolean()
          .optional()
          .describe("Include subdirectories recursively")
      }),
      execute: async ({ path, recursive }) => {
        return sandbox.listFiles(path, { recursive });
      }
    }),

    deleteFile: tool({
      description: "Delete a file",
      inputSchema: z.object({
        path: z.string().describe("Absolute file path to delete")
      }),
      execute: async ({ path }) => {
        return sandbox.deleteFile(path);
      }
    }),

    startProcess: tool({
      description:
        "Start a long-running background process (e.g. a dev server)",
      inputSchema: z.object({
        command: z.string().describe("Command to run in the background"),
        cwd: z.string().optional().describe("Working directory")
      }),
      execute: async ({ command, cwd }) => {
        return sandbox.startProcess(command, { cwd });
      }
    }),

    killProcess: tool({
      description: "Kill a running background process",
      inputSchema: z.object({
        processId: z.string().describe("Process ID to kill")
      }),
      execute: async ({ processId }) => {
        return sandbox.killProcess(processId);
      }
    }),

    listProcesses: tool({
      description: "List all running background processes",
      inputSchema: z.object({}),
      execute: async () => {
        return sandbox.listProcesses();
      }
    })
  };

  return {
    name: "sandbox",
    tools
  };
}
