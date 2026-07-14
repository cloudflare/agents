import { z } from "zod";

import { Think } from "../../src/app/think.js";
import type { AgentHost } from "../../src/app/agent.js";
import { action, type Action } from "../../src/domain/actions/actions.js";
import { createAnthropicModel } from "../../src/adapters/anthropic/model.js";
import { hostAgent } from "../../src/adapters/cloudflare/shell.js";
import { routeAgentRequest } from "../../src/adapters/cloudflare/routing.js";
import type { ModelClient, ModelRequest } from "../../src/ports/model.js";

interface DemoEnv {
  ASSETS: Fetcher;
  DEMO_AGENT_DO: DurableObjectNamespace;
  ANTHROPIC_API_KEY?: string;
  DEMO_MODEL?: string;
}

const short = (value: unknown, max = 120): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function createOfflineModel(): ModelClient {
  return {
    async *stream(request: ModelRequest) {
      const last = request.messages.at(-1);

      if (last?.role === "tool") {
        const result = last.content[0];
        const text =
          result?.isError === true
            ? `The ${result.toolName} call failed: ${short(result.output)}. `
            : `Done - the ${result?.toolName} call came back with ${short(
                result?.output,
                80
              )}. `;
        for (const word of `${text}(offline demo model)`.split(" ")) {
          yield { type: "text-delta" as const, text: `${word} ` };
          await sleep(30);
        }
        yield { type: "finish" as const, finishReason: "stop" as const };
        return;
      }

      const userText =
        last?.role === "user"
          ? last.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join(" ")
              .toLowerCase()
          : "";

      if (userText.includes("email")) {
        yield {
          type: "tool-call" as const,
          toolCallId: `call_${Date.now()}`,
          toolName: "send_demo_email",
          input: {
            to: "bob@example.com",
            subject: "About the launch"
          }
        };
        yield { type: "finish" as const, finishReason: "tool-calls" as const };
        return;
      }

      if (userText.includes("note")) {
        yield {
          type: "tool-call" as const,
          toolCallId: `call_${Date.now()}`,
          toolName: "write",
          input: {
            path: `notes/note-${Date.now()}.md`,
            content: `# Note\n\n${userText}\n`
          }
        };
        yield { type: "finish" as const, finishReason: "tool-calls" as const };
        return;
      }

      const canned =
        "I'm the offline demo model - a scripted ModelClient behind the same " +
        "port a real provider adapter implements. The Worker Durable Object is " +
        "persisting this chat, streaming chunk events over WebSocket, and using " +
        "the real workspace and approval tool paths. Try 'email bob' for an " +
        "approval flow, or 'write a note about launch notes' for a workspace " +
        "tool call.";
      for (const word of canned.split(" ")) {
        yield { type: "text-delta" as const, text: `${word} ` };
        await sleep(35);
      }
      yield { type: "finish" as const, finishReason: "stop" as const };
    }
  };
}

export class DemoThink extends Think {
  model: ModelClient = createOfflineModel();

  protected override getModel(): ModelClient {
    return this.model;
  }

  protected override getSystemPrompt(): string {
    return (
      "You are a concise assistant running inside a Cloudflare Workers demo " +
      "of the rebuilt Think runtime. You have workspace file tools and a " +
      "send_demo_email action that requires human approval."
    );
  }

  protected override getActions(): Record<string, Action> {
    return {
      send_demo_email: action({
        description: "Send an email (demo: pretends to send).",
        inputSchema: z.object({
          to: z.string().describe("Recipient address"),
          subject: z.string().describe("Subject line"),
          body: z.string().optional().describe("Email body")
        }),
        approval: true,
        approvalSummary: "Send an email on your behalf",
        approvalRisk: "medium",
        idempotencyKey: ({ input }) => `email:${input.to}:${input.subject}`,
        execute: async (input) => {
          await sleep(300);
          return {
            sent: true,
            to: input.to,
            subject: input.subject,
            messageId: `demo_${Date.now()}`
          };
        }
      })
    };
  }
}

export const DemoAgentDO = hostAgent(DemoThink, {
  create: (host: AgentHost, _ctx: DurableObjectState, rawEnv: unknown) => {
    const env = rawEnv as DemoEnv;
    const agent = new DemoThink(host);
    if (env.ANTHROPIC_API_KEY) {
      agent.model = createAnthropicModel({
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.DEMO_MODEL ?? "claude-opus-4-8"
      });
    }
    return agent;
  }
});

export default {
  async fetch(request: Request, env: DemoEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return env.ASSETS.fetch(request);
    }

    return (
      (await routeAgentRequest(
        request,
        env as unknown as Record<string, unknown>
      )) ?? new Response("not found", { status: 404 })
    );
  }
};
