/**
 * Assistant — a Think-based chat agent with workspace tools and MCP.
 *
 * Demonstrates Think's core features:
 *   - getModel()         — Workers AI with session affinity
 *   - configureSession() — persistent memory via context blocks
 *   - getTools()         — workspace tools + MCP tools + custom tools
 *   - waitForMcpConnections — MCP integration
 *   - Client-side tools  — getUserTimezone (no execute, handled by onToolCall)
 *   - Tool approval      — calculate (needsApproval for large numbers)
 *   - Workspace          — file read/write/edit via @cloudflare/shell
 */

import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable } from "agents";
import { Think, Session } from "@cloudflare/think";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { Workspace } from "@cloudflare/shell";
import { tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";

export class MyAssistant extends Think<Env> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.name
  });

  waitForMcpConnections = { timeout: 5000 };

  getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  configureSession(session: Session) {
    return session
      .withContext("soul", {
        provider: {
          get: async () =>
            `You are a helpful assistant with access to a workspace filesystem and tools.

You can:
- Read, write, edit, find, grep, and delete files in the workspace
- Check the weather for any city
- Get the user's timezone (runs in their browser)
- Perform calculations (large numbers require user approval)
- Use any tools from connected MCP servers

When asked to write code or create files, use the workspace tools.
Always respond concisely.`
        }
      })
      .withContext("memory", {
        description:
          "Important facts about the user and conversation. Update proactively when you learn something useful.",
        maxTokens: 2000
      })
      .withCachedPrompt();
  }

  getTools(): ToolSet {
    const mcpTools = this.mcp.getAITools();

    return {
      ...createWorkspaceTools(this.workspace),
      ...mcpTools,

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

  getMaxSteps(): number {
    return 5;
  }

  onStart() {
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
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
