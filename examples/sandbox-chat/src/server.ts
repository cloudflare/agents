import { createWorkersAI } from "workers-ai-provider";
import {
  routeAgentRequest,
  callable,
  type Connection,
  type ConnectionContext
} from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs
} from "ai";
import { z } from "zod";
import { getSandbox, proxyToSandbox } from "@cloudflare/sandbox";

import { SandboxWorkspace, type FileInfo } from "./server/sandbox-workspace";
import {
  parseGitStatusPorcelainV2,
  parseGitLog,
  parseGitDiff
} from "./server/git-parsers";
import { backupWorkspace, restoreWorkspace } from "./server/backup";
import { FileWatcher } from "./server/file-watcher";
import { PreviewManager } from "./server/preview";
import { CoderManager } from "./server/coder";
import { AgentPty } from "./server/pty";

export type { ServerMessage, CoderToolOutput } from "./server/types";
export { Sandbox } from "@cloudflare/sandbox";

// ── Agent ───────────────────────────────────────────────────────────

/**
 * AI Chat Agent backed by a container sandbox.
 *
 * The agent can read, write, list, and delete files, execute shell
 * commands, use git, delegate to a coding agent, and persist
 * everything via R2 backups.
 *
 * Terminal access is split into two independent sessions:
 * - **Agent PTY** (server/pty.ts): a private terminal the agent uses
 *   to run commands via the `exec` tool.
 * - **User terminal**: the browser connects directly to the sandbox
 *   via SandboxAddon — it never routes through this Durable Object.
 */
export class SandboxChatAgent extends AIChatAgent {
  // ── Workspace ───────────────────────────────────────────────────

  private _sw: SandboxWorkspace | undefined;
  private _workspaceRestored = false;

  private get sw(): SandboxWorkspace {
    if (!this._sw) {
      const sandbox = getSandbox(this.sandboxBinding, this.name);
      this._sw = new SandboxWorkspace(sandbox);
    }
    return this._sw;
  }

  /** Shorthand for the Sandbox DO namespace binding. */
  private get sandboxBinding(): DurableObjectNamespace {
    return this.env.Sandbox;
  }

  // ── Feature modules ─────────────────────────────────────────────

  private _watcher = new FileWatcher();
  private _preview = new PreviewManager();
  private _coder = new CoderManager();
  private _pty: AgentPty | undefined;

  private get pty(): AgentPty {
    if (!this._pty) {
      this._pty = new AgentPty(this.sandboxBinding, this.name);
    }
    return this._pty;
  }

  // ── Connection lifecycle ────────────────────────────────────────

  override async onConnect(
    conn: Connection,
    ctx: ConnectionContext
  ): Promise<void> {
    const url = new URL(ctx.request.url);

    // Capture host (hostname:port) for preview URL generation
    this._preview.captureHostname(url.host);

    // Start the file watcher if not already running
    if (!this._watcher.isRunning) {
      await this.ensureWorkspace();
      this._watcher.start(this.sw, (msg) => this.broadcast(msg));
    }

    return super.onConnect(conn, ctx);
  }

  override onClose(
    conn: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): void {
    super.onClose(conn, code, reason, wasClean);

    // Stop the file watcher when no clients remain
    let clientCount = 0;
    for (const _c of this.getConnections()) clientCount++;
    if (clientCount === 0) {
      this._watcher.stop();
    }
  }

  // ── Workspace lifecycle ─────────────────────────────────────────

  maxPersistedMessages = 200;

  /**
   * Ensure the workspace is ready: start the container, initialise
   * the agent PTY, and restore the last backup if one exists.
   */
  private async ensureWorkspace(): Promise<void> {
    if (this._workspaceRestored) return;
    this._workspaceRestored = true;

    // Wake the container
    await this.sw.start();

    // Initialise the agent's private PTY
    await this.pty.ensureReady();

    // Restore preview state from sandbox (survives hibernation)
    await this._preview.restore(this.sandboxBinding, this.name);

    // Restore last backup if available
    await restoreWorkspace(this.sw, this.ctx.storage);
  }

  /** Backup helper bound to this agent's workspace + storage. */
  private doBackup = () => backupWorkspace(this.sw, this.ctx.storage);

  // ── Chat handler ────────────────────────────────────────────────

  async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions
  ): Promise<Response> {
    await this.ensureWorkspace();

    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      abortSignal: options?.abortSignal,
      // sessionAffinity routes all requests for this agent to the same
      // Workers AI inference session, enabling KV cache reuse across turns.
      model: workersai("@cf/moonshotai/kimi-k2.5", {
        sessionAffinity: this.sessionAffinity
      }),
      system: [
        "You are a helpful coding assistant with access to an isolated Linux container sandbox.",
        "The sandbox is a JavaScript-first environment with Node.js and Bun pre-installed. JavaScript and TypeScript are the preferred languages.",
        "You have tools for file operations (readFile, writeFile, listDirectory, deleteFile, mkdir, glob).",
        "You have tools for git operations (gitInit, gitStatus, gitAdd, gitCommit, gitLog, gitDiff).",
        "You have an `exec` tool to run shell commands in the sandbox.",
        "You have a `coder` tool that delegates complex coding tasks to an autonomous AI coding agent (OpenCode).",
        "Use the `coder` tool when the user asks you to build, scaffold, or refactor entire projects or apps.",
        "The container has Node.js, Bun, Python, git, and standard Unix tools installed. Prefer JavaScript/TypeScript with Node or Bun over other languages when possible.",
        "The working directory for file operations is /workspace.",
        "When the user asks you to create files or projects, use the tools to actually do it.",
        "When showing file contents, prefer reading them with the readFile tool rather than guessing.",
        "For complex multi-step operations, use the exec tool to run shell commands directly.",
        "You have an `exposePort` tool to expose web servers running on ports 8000-8005. After starting a web server, ALWAYS call exposePort so the user can see the result in the preview pane.",
        "After making changes, briefly summarize what you did."
      ].join("\n"),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        // ── File tools ──────────────────────────────────────────

        readFile: tool({
          description: "Read the contents of a file at the given path",
          inputSchema: z.object({
            path: z
              .string()
              .describe("Absolute file path, e.g. /workspace/src/index.ts")
          }),
          execute: async ({ path }) => {
            const content = await this.sw.readFile(path);
            if (content === null) {
              return { error: `File not found: ${path}` };
            }
            return { path, content };
          }
        }),

        writeFile: tool({
          description:
            "Write content to a file. Creates the file and parent directories if they don't exist.",
          inputSchema: z.object({
            path: z
              .string()
              .describe("Absolute file path, e.g. /workspace/src/index.ts"),
            content: z.string().describe("File content to write")
          }),
          execute: async ({ path, content }) => {
            await this.sw.writeFile(path, content);
            await this.doBackup();
            return { path, bytesWritten: content.length };
          }
        }),

        listDirectory: tool({
          description:
            "List all files and directories at the given path. Returns name, type, and size for each entry.",
          inputSchema: z.object({
            path: z
              .string()
              .describe(
                "Absolute directory path, e.g. /workspace or /workspace/src"
              )
          }),
          execute: async ({ path }) => {
            const entries = await this.sw.readDir(path);
            return {
              path,
              entries: entries.map((e) => ({
                name: e.name,
                type: e.type,
                size: e.size
              }))
            };
          }
        }),

        deleteFile: tool({
          description: "Delete a file",
          inputSchema: z.object({
            path: z.string().describe("Absolute path to delete")
          }),
          execute: async ({ path }) => {
            const deleted = await this.sw.deleteFile(path);
            if (deleted) await this.doBackup();
            return { path, deleted };
          }
        }),

        mkdir: tool({
          description: "Create a directory (and parent directories)",
          inputSchema: z.object({
            path: z.string().describe("Absolute directory path to create")
          }),
          execute: async ({ path }) => {
            await this.sw.mkdir(path, { recursive: true });
            await this.doBackup();
            return { path, created: true };
          }
        }),

        glob: tool({
          description:
            "Find files matching a glob pattern, e.g. /workspace/**/*.ts or /workspace/src/**/*.css",
          inputSchema: z.object({
            pattern: z.string().describe("Glob pattern to match")
          }),
          execute: async ({ pattern }) => {
            const files = await this.sw.glob(pattern);
            return {
              pattern,
              matches: files.map((f) => ({
                path: f.path,
                type: f.type,
                size: f.size
              }))
            };
          }
        }),

        // ── Exec tool ───────────────────────────────────────────

        exec: tool({
          description:
            "Run a shell command in the sandbox. The container has Node.js, Python, git, bash, and standard Unix tools. The working directory is /workspace.",
          inputSchema: z.object({
            command: z
              .string()
              .describe(
                "Shell command to execute, e.g. 'npm init -y' or 'python3 script.py'"
              )
          }),
          execute: async ({ command }) => {
            const { output, timedOut } = await this.pty.exec(command);
            return { output, timedOut };
          }
        }),

        // ── Git tools ───────────────────────────────────────────

        gitInit: tool({
          description: "Initialize a new git repository in the workspace",
          inputSchema: z.object({
            defaultBranch: z
              .string()
              .optional()
              .describe("Default branch name (defaults to main)")
          }),
          execute: async ({ defaultBranch }) => {
            const branch = defaultBranch ?? "main";
            const { output } = await this.pty.exec(
              `cd /workspace && git init -b ${branch} && git config user.name "Agent" && git config user.email "agent@sandbox"`
            );
            await this.doBackup();
            return { initialized: true, branch, output };
          }
        }),

        gitStatus: tool({
          description:
            "Show the working tree status \u2014 lists modified, added, deleted, and untracked files",
          inputSchema: z.object({}),
          execute: async () => {
            const { output } = await this.pty.exec(
              "cd /workspace && git status --porcelain=v2"
            );
            return {
              entries: parseGitStatusPorcelainV2(output),
              clean: output.trim().length === 0
            };
          }
        }),

        gitAdd: tool({
          description:
            'Stage files for commit. Use filepath "." to stage all changes.',
          inputSchema: z.object({
            filepath: z
              .string()
              .describe('File path to stage, or "." for all changes')
          }),
          execute: async ({ filepath }) => {
            const { output } = await this.pty.exec(
              `cd /workspace && git add ${filepath}`
            );
            return { staged: filepath, output };
          }
        }),

        gitCommit: tool({
          description: "Create a commit with the staged changes",
          inputSchema: z.object({
            message: z.string().describe("Commit message"),
            authorName: z.string().optional().describe("Author name"),
            authorEmail: z.string().optional().describe("Author email")
          }),
          execute: async ({ message, authorName, authorEmail }) => {
            const name = authorName ?? "Agent";
            const email = authorEmail ?? "agent@sandbox";
            const escapedMessage = message.replace(/'/g, "'\\''");
            const { output } = await this.pty.exec(
              `cd /workspace && git -c user.name='${name}' -c user.email='${email}' commit -m '${escapedMessage}'`
            );
            await this.doBackup();
            return { committed: true, output };
          }
        }),

        gitLog: tool({
          description: "Show commit history",
          inputSchema: z.object({
            depth: z
              .number()
              .optional()
              .describe("Number of commits to show (default 20)")
          }),
          execute: async ({ depth }) => {
            const n = depth ?? 20;
            const { output } = await this.pty.exec(
              `cd /workspace && git log --format="%H%x1f%s%x1f%an%x1f%ae%x1f%at" -n ${n}`
            );
            return { commits: parseGitLog(output) };
          }
        }),

        gitDiff: tool({
          description: "Show which files have changed since the last commit",
          inputSchema: z.object({}),
          execute: async () => {
            const { output } = await this.pty.exec(
              "cd /workspace && git diff --name-status"
            );
            return { changes: parseGitDiff(output) };
          }
        }),

        // ── Coder tool ──────────────────────────────────────────

        coder: tool({
          description: [
            "Delegate a coding task to an autonomous coding agent (OpenCode) running in the sandbox.",
            "Use this for complex, multi-step coding requests like 'Build me an app that\u2026' or 'Refactor the project to\u2026'.",
            "The agent has full shell, file read/write, and tool access inside /workspace.",
            "Each invocation starts a fresh session. The prompt should be self-contained.",
            "IMPORTANT: When running web services, use ports 8000\u20138005 only. Port 3000 is reserved and must NEVER be used.",
            "Always include this port constraint in the prompt when the task involves a web server or dev server."
          ].join(" "),
          inputSchema: z.object({
            prompt: z
              .string()
              .describe(
                "The coding task description. Be as specific as possible."
              )
          }),
          execute: ({ prompt }, { abortSignal }) =>
            this._coder.runCoder(
              prompt,
              this.sandboxBinding,
              this.name,
              this.env,
              this.doBackup,
              abortSignal
            )
        }),

        // ── Preview tool ────────────────────────────────────────

        exposePort: tool({
          description:
            "Expose a port (8000-8005) from a web server running in the sandbox. Returns a public preview URL that will be displayed in the user's preview pane. Call this AFTER starting a web server.",
          inputSchema: z.object({
            port: z
              .number()
              .describe(
                "Port number to expose (8000-8005). Must match the port your server is listening on."
              )
          }),
          execute: async ({ port }) => {
            return this._preview.exposePort(
              this.sandboxBinding,
              this.name,
              port,
              (msg) => this.broadcast(msg)
            );
          }
        })
      },
      stopWhen: stepCountIs(10)
    });

    return result.toUIMessageStreamResponse();
  }

  // ── Callable RPCs (used by the file browser UI) ─────────────────

  @callable()
  async listFiles(path: string): Promise<FileInfo[]> {
    await this.ensureWorkspace();
    return await this.sw.readDir(path);
  }

  @callable()
  async readFileContent(path: string): Promise<string | null> {
    await this.ensureWorkspace();
    return await this.sw.readFile(path);
  }

  @callable()
  async deleteFileAtPath(path: string): Promise<boolean> {
    await this.ensureWorkspace();
    const deleted = await this.sw.deleteFile(path);
    if (deleted) await this.doBackup();
    return deleted;
  }

  @callable()
  async getWorkspaceInfo(): Promise<{
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
  }> {
    await this.ensureWorkspace();
    return this.sw.getWorkspaceInfo();
  }

  @callable()
  async getPreviewUrl(): Promise<{ url: string; port: number } | null> {
    // Restore preview state in case the DO just woke from hibernation
    await this._preview.restore(this.sandboxBinding, this.name);
    return this._preview.getPreviewUrl();
  }
}

// ── Worker fetch handler ────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env) {
    // Route preview subdomain requests into the sandbox container
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    // Terminal WebSocket proxy — SandboxAddon connects here
    const url = new URL(request.url);
    if (url.pathname === "/ws/terminal") {
      const sandboxId = url.searchParams.get("id");
      if (!sandboxId) {
        return new Response("Missing sandbox id", { status: 400 });
      }
      const sandbox = getSandbox(env.Sandbox, sandboxId);
      return sandbox.terminal(request);
    }

    return (await routeAgentRequest(request, env)) || env.Assets.fetch(request);
  }
} satisfies ExportedHandler<Env>;
