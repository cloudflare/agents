import { tool } from "ai";
import { z } from "zod";
import type { ToolProvider } from "@cloudflare/codemode";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

const RESERVED_SANDBOX_IDS = [
  "www",
  "api",
  "admin",
  "root",
  "system",
  "cloudflare",
  "workers"
];

const sandboxIdSchema = z
  .string()
  .min(1)
  .max(63)
  .refine((id) => !id.startsWith("-") && !id.endsWith("-"), {
    message: "Cannot start or end with hyphens"
  })
  .refine((id) => !RESERVED_SANDBOX_IDS.includes(id.toLowerCase()), {
    message: "Reserved sandbox ID"
  })
  .describe("Sandbox identifier (1-63 chars, no leading/trailing hyphens)");

/**
 * Creates a codemode ToolProvider that exposes Sandbox SDK methods.
 *
 * Takes a DO binding rather than a single sandbox instance — the agent
 * specifies which sandbox to target via a `sandboxId` parameter on every call.
 *
 * NOTE: backup/restore tools require an R2 bucket configured on the Sandbox DO.
 * Bucket mounting tools require S3-compatible storage credentials.
 * These will throw at runtime if the developer hasn't set up the required infrastructure.
 */
export function sandboxTools(
  binding: DurableObjectNamespace<Sandbox>
): ToolProvider {
  const resolve = (sandboxId: string) => getSandbox(binding, sandboxId);

  const tools = {
    exec: tool({
      description: "Execute a shell command in a sandbox",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        command: z.string().describe("Shell command to execute"),
        cwd: z.string().optional().describe("Working directory"),
        timeout: z.number().optional().describe("Timeout in milliseconds"),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variables")
      }),
      execute: async ({ sandboxId, command, cwd, timeout, env }) => {
        return resolve(sandboxId).exec(command, { cwd, timeout, env });
      }
    }),

    readFile: tool({
      description: "Read a file's contents",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        path: z.string().describe("Absolute file path to read")
      }),
      execute: async ({ sandboxId, path }) => {
        return resolve(sandboxId).readFile(path);
      }
    }),

    writeFile: tool({
      description: "Write content to a file (creates or overwrites)",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        path: z.string().describe("Absolute file path to write"),
        content: z.string().describe("File content")
      }),
      execute: async ({ sandboxId, path, content }) => {
        return resolve(sandboxId).writeFile(path, content);
      }
    }),

    listFiles: tool({
      description: "List files in a directory",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
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
      execute: async ({ sandboxId, path, recursive, includeHidden }) => {
        return resolve(sandboxId).listFiles(path, { recursive, includeHidden });
      }
    }),

    deleteFile: tool({
      description: "Delete a file",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        path: z.string().describe("Absolute file path to delete")
      }),
      execute: async ({ sandboxId, path }) => {
        return resolve(sandboxId).deleteFile(path);
      }
    }),

    mkdir: tool({
      description: "Create a directory",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        path: z.string().describe("Directory path to create"),
        recursive: z
          .boolean()
          .optional()
          .describe("Create parent directories if they don't exist")
      }),
      execute: async ({ sandboxId, path, recursive }) => {
        return resolve(sandboxId).mkdir(path, { recursive });
      }
    }),

    renameFile: tool({
      description: "Rename a file or directory",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        oldPath: z.string().describe("Current path"),
        newPath: z.string().describe("New path")
      }),
      execute: async ({ sandboxId, oldPath, newPath }) => {
        return resolve(sandboxId).renameFile(oldPath, newPath);
      }
    }),

    moveFile: tool({
      description: "Move a file or directory to a new location",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        sourcePath: z.string().describe("Source path"),
        destinationPath: z.string().describe("Destination path")
      }),
      execute: async ({ sandboxId, sourcePath, destinationPath }) => {
        return resolve(sandboxId).moveFile(sourcePath, destinationPath);
      }
    }),

    exists: tool({
      description: "Check if a file or directory exists",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        path: z.string().describe("Path to check")
      }),
      execute: async ({ sandboxId, path }) => {
        return resolve(sandboxId).exists(path);
      }
    }),

    startProcess: tool({
      description:
        "Start a long-running background process (e.g. a dev server)",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        command: z.string().describe("Command to run in the background"),
        cwd: z.string().optional().describe("Working directory"),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variables")
      }),
      execute: async ({ sandboxId, command, cwd, env }) => {
        return resolve(sandboxId).startProcess(command, { cwd, env });
      }
    }),

    killProcess: tool({
      description: "Kill a running background process",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        processId: z.string().describe("Process ID to kill")
      }),
      execute: async ({ sandboxId, processId }) => {
        await resolve(sandboxId).killProcess(processId);
        return { success: true };
      }
    }),

    killAllProcesses: tool({
      description: "Kill all running background processes in a sandbox",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema
      }),
      execute: async ({ sandboxId }) => {
        const count = await resolve(sandboxId).killAllProcesses();
        return { killedCount: count };
      }
    }),

    listProcesses: tool({
      description: "List all running background processes in a sandbox",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema
      }),
      execute: async ({ sandboxId }) => {
        return resolve(sandboxId).listProcesses();
      }
    }),

    getProcess: tool({
      description: "Get details about a specific background process",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        processId: z.string().describe("Process ID to look up")
      }),
      execute: async ({ sandboxId, processId }) => {
        return resolve(sandboxId).getProcess(processId);
      }
    }),

    getProcessLogs: tool({
      description: "Get stdout and stderr logs from a background process",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        processId: z.string().describe("Process ID to get logs for")
      }),
      execute: async ({ sandboxId, processId }) => {
        return resolve(sandboxId).getProcessLogs(processId);
      }
    }),

    gitCheckout: tool({
      description: "Clone a git repository into a sandbox",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        repoUrl: z.string().describe("Git repository URL"),
        branch: z.string().optional().describe("Branch to checkout"),
        targetDir: z.string().optional().describe("Target directory path"),
        depth: z
          .number()
          .optional()
          .describe("Clone depth (1 for shallow clone)")
      }),
      execute: async ({ sandboxId, repoUrl, branch, targetDir, depth }) => {
        return resolve(sandboxId).gitCheckout(repoUrl, {
          branch,
          targetDir,
          depth
        });
      }
    }),

    setEnvVars: tool({
      description: "Set or unset environment variables in a sandbox session",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        envVars: z
          .record(z.string(), z.string())
          .describe("Key-value pairs of environment variables to set")
      }),
      execute: async ({ sandboxId, envVars }) => {
        await resolve(sandboxId).setEnvVars(envVars);
        return { success: true };
      }
    }),

    exposePort: tool({
      description:
        "Expose a port running in a sandbox via a public preview URL",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        port: z.number().describe("Port number to expose (1024-65535)"),
        hostname: z.string().describe("Custom domain hostname for preview URL"),
        name: z.string().optional().describe("Friendly name for the port")
      }),
      execute: async ({ sandboxId, port, hostname, name }) => {
        return resolve(sandboxId).exposePort(port, { hostname, name });
      }
    }),

    getExposedPorts: tool({
      description: "List all currently exposed ports and their preview URLs",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        hostname: z.string().describe("Custom domain hostname for preview URLs")
      }),
      execute: async ({ sandboxId, hostname }) => {
        return resolve(sandboxId).getExposedPorts(hostname);
      }
    }),

    createBackup: tool({
      description:
        "Create a backup of a directory. Requires R2 bucket configured on the Sandbox.",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
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
      execute: async ({ sandboxId, dir, name, ttl, gitignore, excludes }) => {
        return resolve(sandboxId).createBackup({
          dir,
          name,
          ttl,
          gitignore,
          excludes
        });
      }
    }),

    restoreBackup: tool({
      description:
        "Restore a previously created backup. Requires R2 bucket configured on the Sandbox.",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
        id: z.string().describe("Backup ID from createBackup result"),
        dir: z.string().describe("Directory that was backed up")
      }),
      execute: async ({ sandboxId, id, dir }) => {
        return resolve(sandboxId).restoreBackup({ id, dir });
      }
    }),

    mountBucket: tool({
      description:
        "Mount an S3-compatible bucket as a filesystem path. Requires storage credentials.",
      inputSchema: z.object({
        sandboxId: sandboxIdSchema,
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
        sandboxId,
        bucket,
        mountPath,
        endpoint,
        provider,
        readOnly,
        prefix
      }) => {
        await resolve(sandboxId).mountBucket(bucket, mountPath, {
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
        sandboxId: sandboxIdSchema,
        mountPath: z.string().describe("Mount path to unmount")
      }),
      execute: async ({ sandboxId, mountPath }) => {
        await resolve(sandboxId).unmountBucket(mountPath);
        return { success: true, mountPath };
      }
    })
  };

  return {
    name: "sandbox",
    tools
  };
}
