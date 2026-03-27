import { tool } from "ai";
import { z } from "zod";
import type { ToolProvider } from "@cloudflare/codemode";

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
    options?: { recursive?: boolean; includeHidden?: boolean }
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

  mkdir(
    path: string,
    options?: { recursive?: boolean }
  ): Promise<{ success: boolean }>;

  renameFile(oldPath: string, newPath: string): Promise<{ success: boolean }>;

  moveFile(
    sourcePath: string,
    destinationPath: string
  ): Promise<{ success: boolean }>;

  exists(path: string): Promise<{ exists: boolean }>;

  startProcess(
    command: string,
    options?: { cwd?: string; env?: Record<string, string> }
  ): Promise<{ processId: string; command: string }>;

  killProcess(id: string): Promise<void>;

  killAllProcesses(): Promise<number>;

  listProcesses(): Promise<{
    processes: Array<{
      processId: string;
      command: string;
      status: string;
    }>;
  }>;

  getProcess(id: string): Promise<{
    id: string;
    command: string;
    status: string;
    pid?: number;
  } | null>;

  getProcessLogs(
    id: string
  ): Promise<{ stdout: string; stderr: string; processId: string }>;

  gitCheckout(
    repoUrl: string,
    options?: { branch?: string; targetDir?: string; depth?: number }
  ): Promise<{ success: boolean }>;

  setEnvVars(envVars: Record<string, string | undefined>): Promise<void>;

  exposePort(
    port: number,
    options: { name?: string; hostname: string; token?: string }
  ): Promise<{ url: string; port: number; name?: string }>;

  getExposedPorts(
    hostname: string
  ): Promise<Array<{ url: string; port: number; status: string }>>;

  // Backup/restore — requires R2 bucket configured on the Sandbox
  createBackup(options: {
    dir: string;
    name?: string;
    ttl?: number;
    gitignore?: boolean;
    excludes?: string[];
  }): Promise<{ id: string; dir: string }>;

  restoreBackup(backup: {
    id: string;
    dir: string;
  }): Promise<{ success: boolean; dir: string; id: string }>;

  // Bucket mounting — requires S3-compatible credentials
  mountBucket(
    bucket: string,
    mountPath: string,
    options: {
      endpoint: string;
      provider?: "r2" | "s3" | "gcs";
      credentials?: { accessKeyId: string; secretAccessKey: string };
      readOnly?: boolean;
      prefix?: string;
    }
  ): Promise<void>;

  unmountBucket(mountPath: string): Promise<void>;
}

/**
 * Creates a codemode ToolProvider that exposes Sandbox SDK methods.
 *
 * Returns a named provider ("sandbox") so the LLM calls sandbox.exec(), sandbox.readFile(), etc.
 *
 * NOTE: backup/restore tools require an R2 bucket configured on the Sandbox DO.
 * Bucket mounting tools require S3-compatible storage credentials.
 * These will throw at runtime if the developer hasn't set up the required infrastructure.
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
          .describe("Include subdirectories recursively"),
        includeHidden: z
          .boolean()
          .optional()
          .describe("Include hidden files (dotfiles)")
      }),
      execute: async ({ path, recursive, includeHidden }) => {
        return sandbox.listFiles(path, { recursive, includeHidden });
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

    mkdir: tool({
      description: "Create a directory",
      inputSchema: z.object({
        path: z.string().describe("Directory path to create"),
        recursive: z
          .boolean()
          .optional()
          .describe("Create parent directories if they don't exist")
      }),
      execute: async ({ path, recursive }) => {
        return sandbox.mkdir(path, { recursive });
      }
    }),

    renameFile: tool({
      description: "Rename a file or directory",
      inputSchema: z.object({
        oldPath: z.string().describe("Current path"),
        newPath: z.string().describe("New path")
      }),
      execute: async ({ oldPath, newPath }) => {
        return sandbox.renameFile(oldPath, newPath);
      }
    }),

    moveFile: tool({
      description: "Move a file or directory to a new location",
      inputSchema: z.object({
        sourcePath: z.string().describe("Source path"),
        destinationPath: z.string().describe("Destination path")
      }),
      execute: async ({ sourcePath, destinationPath }) => {
        return sandbox.moveFile(sourcePath, destinationPath);
      }
    }),

    exists: tool({
      description: "Check if a file or directory exists",
      inputSchema: z.object({
        path: z.string().describe("Path to check")
      }),
      execute: async ({ path }) => {
        return sandbox.exists(path);
      }
    }),

    startProcess: tool({
      description:
        "Start a long-running background process (e.g. a dev server)",
      inputSchema: z.object({
        command: z.string().describe("Command to run in the background"),
        cwd: z.string().optional().describe("Working directory"),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variables")
      }),
      execute: async ({ command, cwd, env }) => {
        return sandbox.startProcess(command, { cwd, env });
      }
    }),

    killProcess: tool({
      description: "Kill a running background process",
      inputSchema: z.object({
        processId: z.string().describe("Process ID to kill")
      }),
      execute: async ({ processId }) => {
        await sandbox.killProcess(processId);
        return { success: true };
      }
    }),

    killAllProcesses: tool({
      description: "Kill all running background processes",
      inputSchema: z.object({}),
      execute: async () => {
        const count = await sandbox.killAllProcesses();
        return { killedCount: count };
      }
    }),

    listProcesses: tool({
      description: "List all running background processes",
      inputSchema: z.object({}),
      execute: async () => {
        return sandbox.listProcesses();
      }
    }),

    getProcess: tool({
      description: "Get details about a specific background process",
      inputSchema: z.object({
        processId: z.string().describe("Process ID to look up")
      }),
      execute: async ({ processId }) => {
        return sandbox.getProcess(processId);
      }
    }),

    getProcessLogs: tool({
      description: "Get stdout and stderr logs from a background process",
      inputSchema: z.object({
        processId: z.string().describe("Process ID to get logs for")
      }),
      execute: async ({ processId }) => {
        return sandbox.getProcessLogs(processId);
      }
    }),

    gitCheckout: tool({
      description: "Clone a git repository into the sandbox",
      inputSchema: z.object({
        repoUrl: z.string().describe("Git repository URL"),
        branch: z.string().optional().describe("Branch to checkout"),
        targetDir: z.string().optional().describe("Target directory path"),
        depth: z
          .number()
          .optional()
          .describe("Clone depth (1 for shallow clone)")
      }),
      execute: async ({ repoUrl, branch, targetDir, depth }) => {
        return sandbox.gitCheckout(repoUrl, { branch, targetDir, depth });
      }
    }),

    setEnvVars: tool({
      description:
        "Set or unset environment variables in the sandbox session. Set a value to undefined to unset it.",
      inputSchema: z.object({
        envVars: z
          .record(z.string(), z.string())
          .describe("Key-value pairs of environment variables to set")
      }),
      execute: async ({ envVars }) => {
        await sandbox.setEnvVars(envVars);
        return { success: true };
      }
    }),

    exposePort: tool({
      description:
        "Expose a port running in the sandbox via a public preview URL",
      inputSchema: z.object({
        port: z.number().describe("Port number to expose (1024-65535)"),
        hostname: z.string().describe("Custom domain hostname for preview URL"),
        name: z.string().optional().describe("Friendly name for the port")
      }),
      execute: async ({ port, hostname, name }) => {
        return sandbox.exposePort(port, { hostname, name });
      }
    }),

    getExposedPorts: tool({
      description: "List all currently exposed ports and their preview URLs",
      inputSchema: z.object({
        hostname: z.string().describe("Custom domain hostname for preview URLs")
      }),
      execute: async ({ hostname }) => {
        return sandbox.getExposedPorts(hostname);
      }
    }),

    createBackup: tool({
      description:
        "Create a backup of a directory in the sandbox. Requires R2 bucket configured on the Sandbox.",
      inputSchema: z.object({
        dir: z.string().describe("Absolute path to directory to back up"),
        name: z.string().optional().describe("Human-readable backup name"),
        ttl: z
          .number()
          .optional()
          .describe("Seconds until auto-deletion (default: 259200 / 3 days)"),
        gitignore: z
          .boolean()
          .optional()
          .describe("Respect .gitignore rules when backing up"),
        excludes: z
          .array(z.string())
          .optional()
          .describe("Glob patterns to exclude (e.g. ['node_modules', '*.log'])")
      }),
      execute: async ({ dir, name, ttl, gitignore, excludes }) => {
        return sandbox.createBackup({ dir, name, ttl, gitignore, excludes });
      }
    }),

    restoreBackup: tool({
      description:
        "Restore a previously created backup. Requires R2 bucket configured on the Sandbox.",
      inputSchema: z.object({
        id: z.string().describe("Backup ID from createBackup result"),
        dir: z.string().describe("Directory that was backed up")
      }),
      execute: async ({ id, dir }) => {
        return sandbox.restoreBackup({ id, dir });
      }
    }),

    mountBucket: tool({
      description:
        "Mount an S3-compatible bucket as a filesystem path inside the sandbox. Requires storage credentials.",
      inputSchema: z.object({
        bucket: z.string().describe("Bucket name"),
        mountPath: z
          .string()
          .describe("Absolute path where the bucket will be mounted"),
        endpoint: z
          .string()
          .describe(
            "S3-compatible endpoint URL (e.g. https://abc.r2.cloudflarestorage.com)"
          ),
        provider: z
          .enum(["r2", "s3", "gcs"])
          .optional()
          .describe(
            "Storage provider hint (auto-detected from endpoint if omitted)"
          ),
        readOnly: z.boolean().optional().describe("Mount as read-only"),
        prefix: z
          .string()
          .optional()
          .describe("Subdirectory prefix within the bucket to mount")
      }),
      execute: async ({
        bucket,
        mountPath,
        endpoint,
        provider,
        readOnly,
        prefix
      }) => {
        await sandbox.mountBucket(bucket, mountPath, {
          endpoint,
          provider,
          readOnly,
          prefix
        });
        return { success: true, bucket, mountPath };
      }
    }),

    unmountBucket: tool({
      description: "Unmount a previously mounted bucket",
      inputSchema: z.object({
        mountPath: z.string().describe("Mount path to unmount")
      }),
      execute: async ({ mountPath }) => {
        await sandbox.unmountBucket(mountPath);
        return { success: true, mountPath };
      }
    })
  };

  return {
    name: "sandbox",
    tools
  };
}
