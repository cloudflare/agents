import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs
} from "ai";
import { z } from "zod";
import {
  Workspace,
  WorkspaceFileSystem,
  type FileInfo
} from "@cloudflare/shell";
import { STATE_TYPES, STATE_SYSTEM_PROMPT } from "@cloudflare/shell";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import { stateTools } from "@cloudflare/shell/workers";
import { createGit, gitTools } from "@cloudflare/shell/git";

/**
 * AI Chat Agent with a persistent virtual filesystem.
 *
 * The agent can read, write, list, and delete files, use isolate-backed
 * state scripts for multi-file workflows, and persist everything in the
 * Workspace's SQLite + R2 hybrid storage.
 */
export class WorkspaceChatAgent extends AIChatAgent {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "ws",
    name: () => this.name
  });

  private _git: ReturnType<typeof createGit> | undefined;
  private git() {
    this._git ??= createGit(new WorkspaceFileSystem(this.workspace));
    return this._git;
  }

  maxPersistedMessages = 200;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: [
        "You are a helpful coding assistant with access to a persistent virtual filesystem and git.",
        "You have direct tools for simple file operations (readFile, writeFile, listDirectory, deleteFile, mkdir, glob).",
        "You have direct tools for git operations (gitInit, gitStatus, gitAdd, gitCommit, gitLog, gitDiff).",
        "For multi-file refactors, coordinated edits, search/replace, edit planning, or any transactional update, use the `runStateCode` tool.",
        "The `runStateCode` sandbox also has `git.*` available (git.clone, git.push, git.pull, git.fetch, git.branch, git.checkout, git.remote, etc.).",
        "There is no bash tool.",
        "When the user asks you to create files or projects, use the tools to actually do it.",
        "When showing file contents, prefer reading them with the readFile tool rather than guessing.",
        "After making changes, briefly summarize what you did.",
        "",
        STATE_SYSTEM_PROMPT.replace("{{types}}", STATE_TYPES)
      ].join("\n"),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        readFile: tool({
          description: "Read the contents of a file at the given path",
          inputSchema: z.object({
            path: z.string().describe("Absolute file path, e.g. /src/index.ts")
          }),
          execute: async ({ path }) => {
            const content = await this.workspace.readFile(path);
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
            path: z.string().describe("Absolute file path, e.g. /src/index.ts"),
            content: z.string().describe("File content to write")
          }),
          execute: async ({ path, content }) => {
            await this.workspace.writeFile(path, content);
            return { path, bytesWritten: content.length };
          }
        }),

        listDirectory: tool({
          description:
            "List all files and directories at the given path. Returns name, type, and size for each entry.",
          inputSchema: z.object({
            path: z.string().describe("Absolute directory path, e.g. / or /src")
          }),
          execute: async ({ path }) => {
            const entries = await this.workspace.readDir(path);
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
          description: "Delete a file or empty directory",
          inputSchema: z.object({
            path: z.string().describe("Absolute path to delete")
          }),
          execute: async ({ path }) => {
            const deleted = await this.workspace.deleteFile(path);
            return { path, deleted };
          }
        }),

        mkdir: tool({
          description: "Create a directory (and parent directories)",
          inputSchema: z.object({
            path: z.string().describe("Absolute directory path to create")
          }),
          execute: async ({ path }) => {
            await this.workspace.mkdir(path, { recursive: true });
            return { path, created: true };
          }
        }),

        runStateCode: tool({
          description:
            "Run JavaScript in an isolated sandbox against the `state` object. Use for any multi-file, transactional, or coordinated filesystem work. The full `state` API is described in the system prompt.",
          inputSchema: z.object({
            code: z
              .string()
              .describe(
                "An async arrow function: async () => { /* use state.* methods */ return result; }. Do NOT use TypeScript syntax."
              )
          }),
          execute: async ({ code }) => {
            const executor = new DynamicWorkerExecutor({
              loader: this.env.LOADER
            });
            return executor.execute(code, [
              resolveProvider(stateTools(this.workspace)),
              resolveProvider(gitTools(this.workspace))
            ]);
          }
        }),

        glob: tool({
          description:
            "Find files matching a glob pattern, e.g. **/*.ts or src/**/*.css",
          inputSchema: z.object({
            pattern: z.string().describe("Glob pattern to match")
          }),
          execute: async ({ pattern }) => {
            const files = await this.workspace.glob(pattern);
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

        gitInit: tool({
          description: "Initialize a new git repository in the workspace",
          inputSchema: z.object({
            defaultBranch: z
              .string()
              .optional()
              .describe("Default branch name (defaults to main)")
          }),
          execute: async ({ defaultBranch }) => {
            return this.git().init({ defaultBranch });
          }
        }),

        gitStatus: tool({
          description:
            "Show the working tree status — lists modified, added, deleted, and untracked files",
          inputSchema: z.object({}),
          execute: async () => {
            return this.git().status();
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
            return this.git().add({ filepath });
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
            const author =
              authorName && authorEmail
                ? { name: authorName, email: authorEmail }
                : undefined;
            return this.git().commit({ message, author });
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
            return this.git().log({ depth });
          }
        }),

        gitDiff: tool({
          description: "Show which files have changed since the last commit",
          inputSchema: z.object({}),
          execute: async () => {
            return this.git().diff();
          }
        })
      },
      stopWhen: stepCountIs(10)
    });

    return result.toUIMessageStreamResponse();
  }

  @callable()
  async listFiles(path: string): Promise<FileInfo[]> {
    return await this.workspace.readDir(path);
  }

  @callable()
  async readFileContent(path: string): Promise<string | null> {
    return await this.workspace.readFile(path);
  }

  @callable()
  async deleteFileAtPath(path: string): Promise<boolean> {
    return await this.workspace.deleteFile(path);
  }

  @callable()
  async getWorkspaceInfo(): Promise<{
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
    r2FileCount: number;
  }> {
    return this.workspace.getWorkspaceInfo();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
