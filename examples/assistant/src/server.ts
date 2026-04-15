/**
 * Assistant — a Think-based chat agent showcasing all Project Think features.
 *
 * Features demonstrated:
 *   - Workspace tools (read, write, edit, find, grep, delete) — built-in
 *   - Sandboxed code execution via @cloudflare/codemode
 *   - Self-authored extensions via ExtensionManager
 *   - Persistent memory via context blocks
 *   - Non-destructive compaction for long conversations
 *   - Full-text search across conversation history (FTS5)
 *   - Dynamic typed configuration (model tier, persona)
 *   - MCP server integration
 *   - Client-side tools and tool approval
 *   - Lifecycle hooks (beforeToolCall logging, afterToolCall analytics)
 *   - Durable chat recovery (chatRecovery)
 *   - Scheduled proactive turns (daily summary)
 *   - Regeneration with branch navigation
 */

import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable } from "agents";
import { Think, Session } from "@cloudflare/think";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { createExtensionTools } from "@cloudflare/think/tools/extensions";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { AgentSearchProvider } from "agents/experimental/memory/session";
import type {
  TurnContext,
  TurnConfig,
  ChatResponseResult,
  ToolCallContext,
  ToolCallResultContext,
  StepContext
} from "@cloudflare/think";
import { tool, generateText } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";

type AgentConfig = {
  modelTier: "fast" | "capable";
  persona: string;
};

export class MyAssistant extends Think<Env, AgentConfig> {
  waitForMcpConnections = { timeout: 5000 };
  override maxSteps = 10;
  chatRecovery = true;
  extensionLoader = this.env.LOADER;

  getModel(): LanguageModel {
    const tier = this.getConfig()?.modelTier ?? "fast";
    const models: Record<string, string> = {
      fast: "@cf/moonshotai/kimi-k2.5",
      capable: "@cf/moonshotai/kimi-k2.5"
    };
    return createWorkersAI({ binding: this.env.AI })(
      models[tier] ?? models.fast,
      { sessionAffinity: this.sessionAffinity }
    );
  }

  configureSession(session: Session) {
    const persona =
      this.getConfig()?.persona ||
      "You are a capable technical assistant. You have access to a persistent workspace, sandboxed code execution, and the ability to create new tools on the fly. You think before you act, and you prefer writing code over making many sequential tool calls.";

    return session
      .withContext("soul", {
        provider: {
          get: async () =>
            `${persona}

Be concise. Prefer short, direct answers over lengthy explanations.
The execute tool runs JavaScript you write in a sandboxed environment. Use it for multi-file operations, data transformations, or any task that would require many sequential tool calls.
You can create extensions: new tools that persist across conversations. Offer to create one when a recurring task would benefit from it.
When you learn something about the user or their project, save it to memory.`
        }
      })
      .withContext("memory", {
        description:
          "Key facts about the user, their preferences, project context, and decisions made during conversation. Update when you learn something that would be useful in future turns.",
        maxTokens: 2000
      })
      .onCompaction(
        createCompactFunction({
          summarize: (prompt) =>
            generateText({ model: this.getModel(), prompt }).then((r) => r.text)
        })
      )
      .compactAfter(50000)
      .withContext("knowledge", {
        description:
          "Searchable knowledge base. Index useful information with set_context and retrieve it later with search_context.",
        provider: new AgentSearchProvider(this)
      })
      .withCachedPrompt();
  }

  getTools(): ToolSet {
    const extensionTools = this.extensionManager
      ? {
          ...createExtensionTools({ manager: this.extensionManager }),
          ...this.extensionManager.getTools()
        }
      : {};

    return {
      execute: createExecuteTool({
        tools: createWorkspaceTools(this.workspace),
        loader: this.env.LOADER
      }),

      ...extensionTools,

      getWeather: tool({
        description: "Get the current weather for a city",
        inputSchema: z.object({
          city: z.string().describe("City name")
        }),
        execute: async ({ city }) => {
          const conditions = ["sunny", "cloudy", "rainy", "snowy"];
          const temp = Math.floor(Math.random() * 30) + 5;
          return {
            city,
            temperature: temp,
            condition:
              conditions[Math.floor(Math.random() * conditions.length)],
            unit: "celsius"
          };
        }
      }),

      getUserTimezone: tool({
        description:
          "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
        inputSchema: z.object({})
      }),

      calculate: tool({
        description:
          "Perform a math calculation. Requires approval for large numbers (over 1000).",
        inputSchema: z.object({
          a: z.number().describe("First number"),
          b: z.number().describe("Second number"),
          operator: z.enum(["+", "-", "*", "/"]).describe("Arithmetic operator")
        }),
        needsApproval: async ({ a, b }) =>
          Math.abs(a) > 1000 || Math.abs(b) > 1000,
        execute: async ({ a, b, operator }) => {
          const ops: Record<string, (x: number, y: number) => number> = {
            "+": (x, y) => x + y,
            "-": (x, y) => x - y,
            "*": (x, y) => x * y,
            "/": (x, y) => x / y
          };
          if (operator === "/" && b === 0) {
            return { error: "Division by zero" };
          }
          return {
            expression: `${a} ${operator} ${b}`,
            result: ops[operator](a, b)
          };
        }
      })
    };
  }

  beforeTurn(ctx: TurnContext): TurnConfig | void {
    console.log(
      `Turn starting: ${Object.keys(ctx.tools).length} tools, continuation=${ctx.continuation}`
    );
  }

  beforeToolCall(ctx: ToolCallContext): void {
    console.log(`Tool call: ${ctx.toolName}`, JSON.stringify(ctx.args));
  }

  afterToolCall(ctx: ToolCallResultContext): void {
    const resultSize = JSON.stringify(ctx.result).length;
    console.log(`Tool result: ${ctx.toolName} (${resultSize} bytes)`);
  }

  onStepFinish(ctx: StepContext): void {
    if (ctx.usage) {
      console.log(
        `Step ${ctx.stepType}: ${ctx.usage.inputTokens}in/${ctx.usage.outputTokens}out`
      );
    }
  }

  onChatResponse(result: ChatResponseResult): void {
    console.log(`Turn ${result.status}: ${result.message.parts.length} parts`);
  }

  async onStart() {
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });

    await this.schedule("0 9 * * *", "dailySummary", {}, { idempotent: true });
  }

  async dailySummary() {
    await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [
          {
            type: "text",
            text: "Generate a brief summary of what we worked on recently. Check the workspace for any files and summarize the current state of things."
          }
        ]
      }
    ]);
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  @callable()
  async getResponseVersions(userMessageId: string) {
    return this.session.getBranches(userMessageId);
  }

  @callable()
  updateConfig(config: AgentConfig) {
    this.configure(config);
  }

  @callable()
  currentConfig() {
    return this.getConfig();
  }

  @callable()
  async listWorkspaceFiles(path: string = "/") {
    try {
      return await this.workspace.readDir(path);
    } catch {
      return [];
    }
  }

  @callable()
  async readWorkspaceFile(path: string) {
    try {
      return await this.workspace.readFile(path);
    } catch {
      return null;
    }
  }

  @callable()
  async listExtensions() {
    if (!this.extensionManager) return [];
    return this.extensionManager.list();
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
