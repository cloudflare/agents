import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  stepCountIs
} from "ai";

import {
  createOpenCodeTool,
  OpenCodeSession
} from "@cloudflare/agents-opencode";
import type { OpenCodeRunOutput } from "@cloudflare/agents-opencode";
import { getSandbox, collectFile } from "@cloudflare/sandbox";

export type { OpenCodeRunOutput };

const MODEL_ID = "@cf/moonshotai/kimi-k2.5";
export { Sandbox } from "@cloudflare/sandbox";

/**
 * AI Chat Agent that delegates JavaScript coding tasks to an autonomous
 * OpenCode agent running inside a sandbox container.
 *
 * The sandbox comes pre-loaded with Node.js, npm, and Bun, making it a
 * fully-equipped JavaScript development environment. The agent has a
 * single tool — `opencode` — which runs a one-shot prompt against the
 * OpenCode agent and streams back progress as UIMessage snapshots.
 */
export class SandboxChatAgent extends AIChatAgent {
  #session: OpenCodeSession | undefined;
  #sessionStarted = false;

  get #activeSession(): OpenCodeSession {
    if (!this.#session) {
      this.#session = new OpenCodeSession(this.env.Sandbox, this.name);
    }
    return this.#session;
  }

  maxPersistedMessages = 200;

  /**
   * Ensure the OpenCode session is started: sandbox is awake, provider
   * is resolved, OpenCode server is running, and any previous state
   * has been restored.
   */
  private async ensureSession(): Promise<void> {
    if (this.#sessionStarted) return;
    this.#sessionStarted = true;

    const result = await this.#activeSession.start(
      this.env as unknown as Record<string, unknown>,
      this.ctx.storage
    );

    this.#activeSession.startFileWatcher((msg) => this.broadcast(msg));

    if (result.sessionState?.runInFlight) {
      console.log(
        "[agent] Restored session with in-flight run:",
        result.sessionState.runPrompt
      );
    }
  }

  private doBackup = () => this.#activeSession.backup(this.ctx.storage);

  override async onConnect(
    conn: Parameters<AIChatAgent["onConnect"]>[0],
    ctx: Parameters<AIChatAgent["onConnect"]>[1]
  ): Promise<void> {
    this.setState({ model: MODEL_ID, sandboxReady: false });
    await this.ensureSession();
    this.setState({ model: MODEL_ID, sandboxReady: true });
    return super.onConnect(conn, ctx);
  }

  override onClose(
    conn: Parameters<AIChatAgent["onClose"]>[0],
    code: number,
    reason: string,
    wasClean: boolean
  ): void {
    super.onClose(conn, code, reason, wasClean);

    let clientCount = 0;
    for (const _c of this.getConnections()) clientCount++;
    if (clientCount === 0) {
      this.#activeSession.stopFileWatcher();
    }
  }

  async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions
  ): Promise<Response> {
    await this.ensureSession();

    const workersai = createWorkersAI({ binding: this.env.AI });

    const systemParts = [
      "<identity>",
      "You are a JavaScript specialist coding agent.",
      "You delegate coding tasks to an autonomous AI coding agent (OpenCode) running in an isolated Linux sandbox.",
      "The sandbox has a full JavaScript toolchain: Node.js, npm, and Bun are all available.",
      "</identity>",
      "",
      "<capabilities>",
      "You have a single tool — `opencode` — which sends a prompt to the OpenCode agent.",
      "The OpenCode agent has full access to the sandbox: it can read/write files, run shell commands, use git, and install packages via npm or bun.",
      "When the user asks you to build, create, modify, or fix JavaScript/TypeScript code, use the `opencode` tool with a clear, specific prompt.",
      "Include relevant context in your prompt: file paths, technology preferences, port constraints (use ports 8000-8005 only, never port 3000).",
      "After the opencode tool completes, briefly summarize what was done.",
      "</capabilities>",
      "",
      "<output-files>",
      "Always set the `outputFile` parameter so the user can download the result.",
      "When the task produces a single file artifact (image, CSV, PDF, HTML page, etc.), set `outputFile` to its absolute path in the sandbox.",
      "When the task produces multiple files (a full project, several source files, etc.), instruct the agent to zip them into a single archive and set `outputFile` to the zip path (e.g. `/workspace/project.zip`).",
      "</output-files>"
    ];

    const restoreContext = this.#activeSession.getRestoreContext();
    if (restoreContext) {
      systemParts.push(restoreContext);
    }

    const { tool: opencode, pruneSubMessages } = createOpenCodeTool({
      sandbox: this.env.Sandbox,
      name: this.name,
      env: this.env as unknown as Record<string, unknown>,
      storage: this.ctx.storage,
      description: [
        "Delegate a JavaScript/TypeScript coding task to an autonomous coding agent (OpenCode) running in the sandbox.",
        "The sandbox has Node.js, npm, and Bun pre-installed.",
        "Use this for any JS/TS coding request: building apps, creating files, refactoring, debugging, running commands, etc.",
        "The agent has full shell, file read/write, and tool access inside /workspace.",
        "IMPORTANT: When running web services, use ports 8000\u20138005 only. Port 3000 is reserved and must NEVER be used.",
        "Always set the `outputFile` parameter so the user can download the result.",
        "When the task produces a single file artifact (image, CSV, PDF, HTML page, etc.), set `outputFile` to its absolute path in the sandbox (e.g. `/workspace/output.png`).",
        "When the task produces multiple files (a full project, several source files, etc.), instruct the agent to zip them into a single archive and set `outputFile` to the zip path (e.g. `/workspace/project.zip`)."
      ].join(" ")
    });

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai(MODEL_ID, {
        sessionAffinity: this.sessionAffinity
      }),
      system: systemParts.join("\n"),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-10-messages",
        reasoning: "before-last-message"
      }),
      tools: { opencode },
      prepareStep: pruneSubMessages(),
      stopWhen: stepCountIs(10)
    });

    return result.toUIMessageStreamResponse();
  }
}

/** MIME type lookup for common file extensions. */
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".json": "application/json",
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".ts": "text/plain",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip"
};

function getMimeType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const artifactPrefix = "/artifacts/";

    if (url.pathname.startsWith(artifactPrefix)) {
      // Route: /artifacts/<sandboxId>/<path...>
      const rest = url.pathname.slice(artifactPrefix.length);
      const slashIndex = rest.indexOf("/");
      if (slashIndex === -1) {
        return new Response("Bad request: missing file path", { status: 400 });
      }
      const sandboxId = rest.slice(0, slashIndex);
      const filePath = rest.slice(slashIndex); // includes leading /

      try {
        const sandbox = getSandbox(env.Sandbox, sandboxId);
        const stream = await sandbox.readFileStream(filePath);
        if (!stream) {
          return new Response("File not found", { status: 404 });
        }
        const { content, metadata } = await collectFile(stream);
        const fileName = filePath.split("/").pop() ?? "download";
        const contentType = metadata.mimeType ?? getMimeType(filePath);
        const body =
          content instanceof Uint8Array
            ? content
            : new TextEncoder().encode(content);
        return new Response(body as BodyInit, {
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": `attachment; filename="${fileName}"`,
            "Cache-Control": "no-cache"
          }
        });
      } catch (_err) {
        return new Response("Sandbox not found or file not accessible", {
          status: 404
        });
      }
    }

    return (await routeAgentRequest(request, env)) || env.Assets.fetch(request);
  }
} satisfies ExportedHandler<Env>;
