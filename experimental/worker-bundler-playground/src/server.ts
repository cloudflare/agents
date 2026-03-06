import { routeAgentRequest, callable } from "agents";
import { Workspace } from "agents/experimental/workspace";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createWorker } from "@cloudflare/worker-bundler";
import type { CreateWorkerResult } from "@cloudflare/worker-bundler";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

export interface WorkerState {
  built: boolean;
  mainModule?: string;
  moduleNames?: string[];
  warnings?: string[];
  source?: Record<string, string>;
}

export class WorkerPlayground extends AIChatAgent<Env> {
  workspace = new Workspace(this);
  currentWorkerResult?: CreateWorkerResult;

  async onStart() {
    // Restore and broadcast worker state from workspace so clients
    // see the right panel immediately on connect / page refresh
    const source = await this.readSourceFiles();
    if (Object.keys(source).length > 0) {
      const state: WorkerState = {
        built: true,
        source
      };
      this.setState(state);
    }
  }

  private async readSourceFiles(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const entries = this.workspace.glob("/**");

    for (const entry of entries) {
      if (entry.type === "file") {
        const content = await this.workspace.readFile(entry.path);
        if (content !== null) {
          // Strip leading slash to match createWorker's expected format
          files[entry.path.slice(1)] = content;
        }
      }
    }

    return files;
  }

  @callable({ description: "Clear all workspace files and reset state" })
  async clearWorkspace(): Promise<void> {
    const existing = this.workspace.glob("/**");
    for (const entry of existing) {
      if (entry.type === "file") {
        await this.workspace.deleteFile(entry.path);
      }
    }
    this.currentWorkerResult = undefined;
    this.setState({} as WorkerState);
  }

  @callable({ description: "Build a Worker from source files" })
  async buildWorker(files: Record<string, string>): Promise<WorkerState> {
    const result = await createWorker({ files });
    this.currentWorkerResult = result;

    // Persist to workspace only after a successful build
    const existing = this.workspace.glob("/**");
    for (const entry of existing) {
      if (entry.type === "file") {
        await this.workspace.deleteFile(entry.path);
      }
    }
    for (const [path, content] of Object.entries(files)) {
      await this.workspace.writeFile("/" + path, content);
    }

    const state: WorkerState = {
      built: true,
      mainModule: result.mainModule,
      moduleNames: Object.keys(result.modules),
      warnings: result.warnings,
      source: files
    };

    // Push to all connected clients so the right panel updates
    this.setState(state);

    return state;
  }

  private async ensureWorkerBuilt(): Promise<CreateWorkerResult> {
    if (this.currentWorkerResult) {
      return this.currentWorkerResult;
    }

    // Rebuild from workspace files after hibernation
    const source = await this.readSourceFiles();
    if (Object.keys(source).length === 0) {
      throw new Error("No worker has been built yet. Build one first.");
    }

    const result = await createWorker({ files: source });
    this.currentWorkerResult = result;
    return result;
  }

  @callable({
    description: "Send a request to the built Worker and return the response"
  })
  async testWorker(
    method: string,
    path: string,
    body?: string,
    headers?: Record<string, string>
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    const result = await this.ensureWorkerBuilt();
    const worker = this.env.LOADER.get("playground-" + this.name, () => ({
      mainModule: result.mainModule,
      modules: result.modules,
      compatibilityDate:
        result.wranglerConfig?.compatibilityDate ?? "2026-01-28",
      compatibilityFlags: result.wranglerConfig?.compatibilityFlags
    }));

    const reqInit: RequestInit = { method };
    if (body && method !== "GET" && method !== "HEAD") {
      reqInit.body = body;
    }
    if (headers) {
      reqInit.headers = headers;
    }

    const response = await worker
      .getEntrypoint()
      .fetch(new Request("http://playground" + path, reqInit));

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value: string, key: string) => {
      responseHeaders[key] = value;
    });

    return {
      status: response.status,
      headers: responseHeaders,
      body: await response.text()
    };
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: [
        "You are a Worker code generator. The user describes what they want and you write Cloudflare Worker code.",
        "When the user asks you to build something, use the generateWorker tool to produce the source files.",
        "The tool will automatically bundle and load the Worker so the user can test it.",
        "",
        "Guidelines for generating Workers:",
        "- Always export a default object with a fetch(request) handler, or a class extending WorkerEntrypoint.",
        "- Use TypeScript (.ts files).",
        '- Put the entry point at "src/index.ts".',
        '- If the user needs npm packages, include a "package.json" with dependencies.',
        "- Keep the code simple and focused on what the user asked for.",
        "- Use modern JS/TS syntax (async/await, template literals, etc.).",
        "",
        "After generating, tell the user what you built and suggest they test it with a specific request.",
        "If they ask to test it, use the testWorker tool to send a request and show the response."
      ].join("\n"),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        generateWorker: tool({
          description:
            "Generate Worker source files, bundle them, and load the Worker. " +
            "Provide a record of file paths to file contents. " +
            'Always include "src/index.ts" as the entry point. ' +
            'Optionally include "package.json" for npm dependencies.',
          inputSchema: z.object({
            files: z
              .record(z.string(), z.string())
              .describe(
                'Map of file paths to contents, e.g. {"src/index.ts": "...", "package.json": "..."}'
              )
          }),
          execute: async ({ files }) => this.buildWorker(files)
        }),
        testWorker: tool({
          description:
            "Send an HTTP request to the currently loaded Worker and return the response.",
          inputSchema: z.object({
            method: z
              .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
              .describe("HTTP method"),
            path: z.string().describe("Request path, e.g. / or /api/greet"),
            body: z
              .string()
              .optional()
              .describe("Request body (for POST/PUT/PATCH)"),
            headers: z
              .record(z.string(), z.string())
              .optional()
              .describe("Request headers")
          }),
          execute: async ({ method, path, body, headers }) =>
            this.testWorker(method, path, body, headers)
        })
      },
      stopWhen: stepCountIs(8)
    });

    return result.toUIMessageStreamResponse();
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
