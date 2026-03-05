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
import { Workspace, type FileInfo } from "agents/experimental/workspace";

/**
 * AI Chat Agent with a persistent virtual filesystem.
 *
 * The agent can read, write, list, and delete files, run bash commands,
 * and use bash sessions for multi-step shell workflows — all backed by
 * the Workspace's SQLite + R2 hybrid storage.
 */
export class WorkspaceChatAgent extends AIChatAgent {
  workspace = new Workspace(this, { namespace: "ws" });

  maxPersistedMessages = 200;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: [
        "You are a helpful coding assistant with access to a persistent virtual filesystem.",
        "You can read, write, list, and delete files, create directories, and run bash commands.",
        "When the user asks you to create files or projects, use the tools to actually do it.",
        "When showing file contents, prefer reading them with the readFile tool rather than guessing.",
        "After making changes, briefly summarize what you did."
      ].join(" "),
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

        bash: tool({
          description:
            "Run a bash command in the workspace filesystem. Use for searching, transforming files, or running scripts.",
          inputSchema: z.object({
            command: z.string().describe("Bash command to execute"),
            cwd: z
              .string()
              .optional()
              .describe("Working directory (default: /)")
          }),
          execute: async ({ command, cwd }) => {
            const result = await this.workspace.bash(command, { cwd });
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode
            };
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
