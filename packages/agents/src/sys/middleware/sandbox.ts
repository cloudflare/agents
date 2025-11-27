/**
 * Sandbox Middleware
 *
 * Provides tools for executing commands in an isolated Linux container.
 * Uses @cloudflare/sandbox for ephemeral container execution.
 *
 * IMPORTANT: These tools operate on an EPHEMERAL sandbox container filesystem,
 * NOT the agent's persistent R2-backed filesystem. Use for:
 * - Running bash commands (git, npm, python, etc.)
 * - Searching code with ripgrep
 * - Cloning and analyzing repositories
 * - Running tests and linters
 *
 * For persistent file storage, use the `filesystem` middleware instead.
 */

import { z } from "zod";
import { tool } from "./tools";
import type { AgentMiddleware } from "../types";

// ============================================================================
// Schemas
// ============================================================================

const SandboxBashSchema = z.object({
  command: z.string().describe("The bash command to execute in the sandbox"),
  cwd: z
    .string()
    .default("/workspace")
    .describe(
      "Working directory in the sandbox container. Defaults to /workspace."
    ),
  timeout: z
    .number()
    .int()
    .default(30000)
    .describe("Timeout in milliseconds before the command is killed")
});

const SandboxGrepSchema = z.object({
  pattern: z.string().describe("The pattern to search for (supports regex)"),
  path: z
    .string()
    .default("/workspace")
    .describe(
      "Directory or file path to search in the sandbox. Defaults to /workspace."
    ),
  glob: z
    .string()
    .optional()
    .describe(
      'Glob pattern for filtering files (e.g., "*.ts" for TypeScript files)'
    ),
  ignoreCase: z
    .boolean()
    .default(false)
    .describe("Whether to ignore case when matching"),
  maxResults: z
    .number()
    .int()
    .default(50)
    .describe("Maximum number of results to return")
});

const SandboxGlobSchema = z.object({
  patterns: z
    .array(z.string())
    .describe("One or more glob patterns to match files in the sandbox"),
  cwd: z
    .string()
    .default("/workspace")
    .describe("Directory to search in the sandbox. Defaults to /workspace."),
  maxResults: z
    .number()
    .int()
    .default(100)
    .describe("Maximum number of results to return")
});

const SandboxLsSchema = z.object({
  path: z
    .string()
    .default("/workspace")
    .describe("Directory path in the sandbox to list. Defaults to /workspace."),
  recursive: z
    .boolean()
    .default(false)
    .describe("Whether to list recursively (uses tree command)"),
  maxDepth: z
    .number()
    .int()
    .default(3)
    .describe("Maximum depth for recursive listing")
});

const SandboxReadFileSchema = z.object({
  path: z.string().describe("Path to the file in the sandbox container"),
  startLine: z
    .number()
    .int()
    .optional()
    .describe("The line number to start reading from (1-based)"),
  endLine: z
    .number()
    .int()
    .optional()
    .describe("The line number to end reading at (1-based)")
});

const SandboxWriteFileSchema = z.object({
  path: z.string().describe("Path to write the file in the sandbox container"),
  content: z.string().describe("The content to write to the file")
});

const SandboxGitDiffSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Path to get diff for. If empty, shows all changes."),
  base: z
    .string()
    .default("HEAD~1")
    .describe("Base commit/branch to compare against (e.g., 'main', 'HEAD~1')")
});

const SandboxGitCloneSchema = z.object({
  url: z.string().describe("The git repository URL to clone"),
  branch: z.string().optional().describe("Branch to checkout after cloning"),
  depth: z
    .number()
    .int()
    .default(1)
    .describe("Create a shallow clone with this many commits")
});

// ============================================================================
// Config
// ============================================================================

/**
 * Sandbox middleware configuration.
 * Set via agent blueprint config: `config: { sandbox: { env: { GITHUB_TOKEN: "..." } } }`
 */
export interface SandboxConfig {
  /** Environment variables to inject into sandbox commands */
  env?: Record<string, string>;
}

// ============================================================================
// Sandbox Interface
// ============================================================================

interface SandboxExecOptions {
  timeout?: number;
  env?: Record<string, string>;
}

interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

interface SandboxInstance {
  exec(
    command: string,
    options?: SandboxExecOptions
  ): Promise<SandboxExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
}

/**
 * Get a sandbox instance from the SANDBOX DO namespace.
 * Uses the standard RPC pattern - the Sandbox DO exposes exec/writeFile/readFile methods.
 */
function getSandboxInstance(
  ns: DurableObjectNamespace,
  id: string
): SandboxInstance {
  const doId = ns.idFromName(id);
  const stub = ns.get(doId);

  // The Sandbox DO stub exposes RPC methods directly
  // Cast to our interface - the actual implementation comes from @cloudflare/sandbox DO
  return stub as unknown as SandboxInstance;
}

// ============================================================================
// Prompts
// ============================================================================

const SANDBOX_SYSTEM_PROMPT = `## Sandbox Container

You have access to an isolated Linux container (sandbox) for executing commands.

**IMPORTANT**: The sandbox filesystem is EPHEMERAL - files created here are temporary and will be lost when the sandbox is destroyed. For persistent storage, use the agent's filesystem tools (ls, read_file, write_file) which are backed by R2 storage.

### Sandbox Tools (ephemeral container):
- \`sandbox_bash\`: Execute any bash command (git, npm, python, etc.)
- \`sandbox_grep\`: Fast code search using ripgrep
- \`sandbox_glob\`: Find files by pattern using fd
- \`sandbox_ls\`: List directories with optional tree view
- \`sandbox_read_file\`: Read file contents from the container
- \`sandbox_write_file\`: Write files to the container
- \`sandbox_git_clone\`: Clone repositories into /workspace
- \`sandbox_git_diff\`: Show git diffs

### Workflow Tips:
1. Clone repos with \`sandbox_git_clone\` - they land in /workspace
2. Explore with \`sandbox_ls\` (recursive for tree view)
3. Search with \`sandbox_grep\` for specific patterns
4. Run tests/linters with \`sandbox_bash\`
5. Use \`sandbox_git_diff\` to review changes`;

// ============================================================================
// Middleware
// ============================================================================

/**
 * Sandbox middleware - provides tools for ephemeral container execution.
 *
 * Requires:
 * - SANDBOX binding in wrangler.jsonc pointing to a Sandbox Durable Object
 *   (see @cloudflare/sandbox for the DO implementation)
 *
 * Tools are prefixed with "sandbox_" to distinguish them from the
 * persistent R2-backed filesystem tools.
 */
export const sandbox: AgentMiddleware<SandboxConfig> = {
  name: "sandbox",

  async beforeModel(ctx, plan) {
    const sandboxNs = ctx.env.SANDBOX;
    if (!sandboxNs) {
      console.warn(
        "SANDBOX binding not found. Sandbox tools disabled. Add SANDBOX to your wrangler.jsonc."
      );
      return;
    }

    plan.addSystemPrompt(SANDBOX_SYSTEM_PROMPT);

    // Create sandbox instance scoped to this agent thread
    const sandboxId = `agent-${ctx.agent.info.threadId}`;
    const sb = getSandboxInstance(sandboxNs, sandboxId);

    // Get env vars from config (e.g., GITHUB_TOKEN for git auth)
    const config = (ctx.agent.config as { sandbox?: SandboxConfig })?.sandbox;
    const sandboxEnv = config?.env;

    // Helper to exec with env vars injected
    const exec = (
      cmd: string,
      opts?: { timeout?: number }
    ): Promise<SandboxExecResult> => sb.exec(cmd, { ...opts, env: sandboxEnv });

    // Dangerous command patterns to block
    const DANGEROUS_PATTERNS = [
      "rm -rf /",
      "mkfs",
      "dd if=",
      ":(){",
      "fork bomb"
    ];

    const checkDangerous = (cmd: string): string | null => {
      for (const pattern of DANGEROUS_PATTERNS) {
        if (cmd.includes(pattern)) {
          return `Blocked: potentially dangerous command pattern "${pattern}"`;
        }
      }
      return null;
    };

    // -------------------------------------------------------------------------
    // sandbox_bash
    // -------------------------------------------------------------------------
    const sandbox_bash = tool({
      name: "sandbox_bash",
      description:
        "Execute a bash command in an isolated Linux container. Supports git, npm, python, and common CLI tools. The sandbox filesystem is EPHEMERAL - use for running tests, git operations, and code analysis.",
      inputSchema: SandboxBashSchema,
      execute: async ({ command, cwd, timeout }) => {
        const blocked = checkDangerous(command);
        if (blocked) return blocked;

        try {
          const fullCommand =
            cwd !== "/workspace" ? `cd ${cwd} && ${command}` : command;
          const result = await exec(fullCommand, { timeout });

          let output = "";
          if (result.stdout) output += result.stdout;
          if (result.stderr)
            output += (output ? "\n" : "") + `STDERR: ${result.stderr}`;

          if (!output.trim()) {
            return result.success
              ? "Command executed successfully (no output)"
              : `Command failed with exit code ${result.exitCode}`;
          }

          return output;
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    });

    // -------------------------------------------------------------------------
    // sandbox_grep
    // -------------------------------------------------------------------------
    const sandbox_grep = tool({
      name: "sandbox_grep",
      description:
        "Search for patterns in sandbox files using ripgrep. Fast, respects .gitignore. Returns matching lines with file paths and line numbers. Operates on the EPHEMERAL sandbox filesystem.",
      inputSchema: SandboxGrepSchema,
      execute: async ({
        pattern,
        path,
        glob: globPattern,
        ignoreCase,
        maxResults
      }) => {
        try {
          let cmd = `rg --line-number --max-count ${maxResults}`;
          if (ignoreCase) cmd += " --ignore-case";
          if (globPattern) cmd += ` --glob '${globPattern}'`;
          cmd += ` '${pattern}' ${path}`;

          const result = await exec(cmd);

          if (result.exitCode === 1 && !result.stdout) {
            return `No matches found for pattern "${pattern}"`;
          }

          if (result.stderr && !result.stdout) {
            return `Error: ${result.stderr}`;
          }

          return result.stdout || "No matches found";
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    });

    // -------------------------------------------------------------------------
    // sandbox_glob
    // -------------------------------------------------------------------------
    const sandbox_glob = tool({
      name: "sandbox_glob",
      description:
        "Find files matching glob patterns in the sandbox using fd. Fast, respects .gitignore. Operates on the EPHEMERAL sandbox filesystem.",
      inputSchema: SandboxGlobSchema,
      execute: async ({ patterns, cwd, maxResults }) => {
        try {
          const results: string[] = [];
          for (const pattern of patterns) {
            // Try fd first, fall back to fdfind (Debian/Ubuntu)
            const cmd = `(fd --max-results ${maxResults} '${pattern}' ${cwd} 2>/dev/null || fdfind --max-results ${maxResults} '${pattern}' ${cwd})`;
            const result = await exec(cmd);
            if (result.stdout) {
              results.push(...result.stdout.trim().split("\n").filter(Boolean));
            }
          }

          if (results.length === 0) {
            return `No files found matching: ${patterns.join(", ")}`;
          }

          return `Found ${results.length} file(s):\n${results.join("\n")}`;
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    });

    // -------------------------------------------------------------------------
    // sandbox_ls
    // -------------------------------------------------------------------------
    const sandbox_ls = tool({
      name: "sandbox_ls",
      description:
        "List files and directories in the sandbox. Use recursive option for tree view. Operates on the EPHEMERAL sandbox filesystem.",
      inputSchema: SandboxLsSchema,
      execute: async ({ path, recursive, maxDepth }) => {
        try {
          const cmd = recursive
            ? `tree -L ${maxDepth} --noreport ${path} 2>/dev/null || find ${path} -maxdepth ${maxDepth} -print`
            : `ls -la ${path}`;

          const result = await exec(cmd);
          return result.stdout || result.stderr || "No output";
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    });

    // -------------------------------------------------------------------------
    // sandbox_read_file
    // -------------------------------------------------------------------------
    const sandbox_read_file = tool({
      name: "sandbox_read_file",
      description:
        "Read a file from the sandbox container. Supports line range selection for large files. Operates on the EPHEMERAL sandbox filesystem - NOT the agent's persistent storage.",
      inputSchema: SandboxReadFileSchema,
      execute: async ({ path: filePath, startLine, endLine }) => {
        try {
          // Check if file exists
          const existsResult = await exec(
            `test -f '${filePath}' && echo "exists"`
          );
          if (!existsResult.stdout?.includes("exists")) {
            return `Error: File not found in sandbox: ${filePath}`;
          }

          // Read with optional line range
          let cmd: string;
          if (startLine && endLine) {
            cmd = `sed -n '${startLine},${endLine}p' '${filePath}' | cat -n`;
          } else if (startLine) {
            cmd = `tail -n +${startLine} '${filePath}' | head -200 | cat -n`;
          } else {
            cmd = `head -200 '${filePath}' | cat -n`;
          }

          const result = await exec(cmd);

          if (result.stderr && !result.stdout) {
            return `Error reading file: ${result.stderr}`;
          }

          const lineInfo =
            startLine && endLine
              ? `Lines ${startLine}-${endLine}`
              : startLine
                ? `Lines from ${startLine}`
                : "First 200 lines";

          return `File: ${filePath}\n${lineInfo}:\n\n${result.stdout}`;
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    });

    // -------------------------------------------------------------------------
    // sandbox_write_file
    // -------------------------------------------------------------------------
    const sandbox_write_file = tool({
      name: "sandbox_write_file",
      description:
        "Write content to a file in the sandbox container. Creates directories if needed. Operates on the EPHEMERAL sandbox filesystem - files will be lost when sandbox ends. For persistent storage, use the agent's write_file tool.",
      inputSchema: SandboxWriteFileSchema,
      execute: async ({ path: filePath, content }) => {
        try {
          await sb.writeFile(filePath, content);
          return `File written to sandbox: ${filePath}`;
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    });

    // -------------------------------------------------------------------------
    // sandbox_git_clone
    // -------------------------------------------------------------------------
    const sandbox_git_clone = tool({
      name: "sandbox_git_clone",
      description:
        "Clone a git repository into the sandbox workspace at /workspace. The cloned repo is EPHEMERAL and will be lost when the sandbox ends.",
      inputSchema: SandboxGitCloneSchema,
      execute: async ({ url, branch, depth }) => {
        try {
          // Clear workspace first
          await exec(
            "rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null || true"
          );

          let cmd = `cd /workspace && git clone --depth ${depth}`;
          if (branch) cmd += ` --branch '${branch}'`;
          cmd += ` '${url}' .`;

          const result = await exec(cmd, { timeout: 60000 });

          if (result.exitCode !== 0) {
            return `Error cloning: ${result.stderr || "Unknown error"}`;
          }

          // Show what we got
          const lsResult = await exec(
            "cd /workspace && ls -la && echo '---' && git log --oneline -5 2>/dev/null || true"
          );

          return `Repository cloned to /workspace!\n\n${lsResult.stdout}`;
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    });

    // -------------------------------------------------------------------------
    // sandbox_git_diff
    // -------------------------------------------------------------------------
    const sandbox_git_diff = tool({
      name: "sandbox_git_diff",
      description:
        "Show git diff for changes in the sandbox workspace. Works with repositories cloned via sandbox_git_clone.",
      inputSchema: SandboxGitDiffSchema,
      execute: async ({ path, base }) => {
        try {
          let cmd = `cd /workspace && git diff ${base}`;
          if (path) cmd += ` -- '${path}'`;

          const result = await exec(cmd);

          if (result.exitCode !== 0 && result.stderr) {
            return `Error: ${result.stderr}`;
          }

          return result.stdout || "No changes detected";
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    });

    // Register all tools
    ctx.registerTool(sandbox_bash);
    ctx.registerTool(sandbox_grep);
    ctx.registerTool(sandbox_glob);
    ctx.registerTool(sandbox_ls);
    ctx.registerTool(sandbox_read_file);
    ctx.registerTool(sandbox_write_file);
    ctx.registerTool(sandbox_git_clone);
    ctx.registerTool(sandbox_git_diff);
  },

  tags: ["sandbox", "container", "bash", "git"]
};
