import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  isStepCount
} from "ai";
import { Workspace } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { createAITools } from "@cloudflare/computer/tools/ai-sdk";

type FileEntry = {
  name: string;
  type: "file" | "directory" | "symlink";
  size: number;
  path: string;
};

/**
 * AI Chat Agent with a persistent virtual filesystem.
 *
 * The workspace is a `Workspace` from `@cloudflare/computer`, stored in the
 * agent's SQLite. The model gets Computer's file tools (`read`, `ls`, `find`,
 * `grep`, `write`, `edit`, `delete`) and an `exec` tool that runs JavaScript
 * modules against the workspace in a Dynamic Worker, with git through the
 * `ws:git` module.
 */
export class WorkspaceChatAgent extends AIChatAgent {
  workspace = new Workspace({
    storage: this.ctx.storage,
    git: createGitClient(),
    defaultGitIdentity: { name: "Workspace Chat", email: "agent@example.com" },
    backends: [
      new WorkerJavaScriptBackend({
        id: "js",
        loader: this.env.LOADER,
        access: "read-write",
        modules: { "ws:git": createGitModule({ allowNetwork: true }) }
      })
    ]
  });

  maxPersistedMessages = 200;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/moonshotai/kimi-k2.7-code", {
        sessionAffinity: this.sessionAffinity
      }),
      instructions: [
        "You are a helpful coding assistant with a persistent workspace rooted at /workspace.",
        "Use read, ls, find, and grep to inspect files, and write, edit, and delete to change them.",
        "For multi-file work or anything that needs code, use exec to run a JavaScript module. It can import `node:fs/promises` and, for git, `ws:git` (status, diff, log, clone, cli).",
        "When the user asks you to create files or projects, use the tools to actually do it.",
        "After making changes, briefly summarize what you did."
      ].join("\n"),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: createAITools({ workspace: this.workspace }),
      stopWhen: isStepCount(10)
    });

    return result.toUIMessageStreamResponse();
  }

  @callable()
  async listFiles(path: string): Promise<FileEntry[]> {
    try {
      const entries = await this.workspace.fs.readdir(path);
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory
          ? "directory"
          : entry.isSymbolicLink
            ? "symlink"
            : "file",
        size: entry.size,
        path: path === "/" ? `/${entry.name}` : `${path}/${entry.name}`
      }));
    } catch {
      return [];
    }
  }

  @callable()
  async readFileContent(path: string): Promise<string | null> {
    try {
      return await this.workspace.fs.readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  @callable()
  async deleteFileAtPath(path: string): Promise<boolean> {
    try {
      await this.workspace.fs.rm(path, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  @callable()
  async getWorkspaceInfo(): Promise<{
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
  }> {
    const found = await this.workspace.fs.find("/", "**");
    const files = found.filter((entry) => entry.type === "file");
    const sizes = await Promise.all(
      files.map(
        async (entry) => (await this.workspace.fs.stat(entry.path)).size
      )
    );
    return {
      fileCount: files.length,
      directoryCount: found.filter((entry) => entry.type === "dir").length,
      totalBytes: sizes.reduce((total, size) => total + size, 0)
    };
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
