import {
  AIChatAgent,
  type OnChatMessageOptions,
  createToolsFromClientSchemas
} from "../src/index";
import { streamText, tool, convertToModelMessages, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod/v4";
import { routeAgentRequest } from "agents";

export type Env = {
  ChatAgent: DurableObjectNamespace<ChatAgent>;
  LlmChatAgent: DurableObjectNamespace<LlmChatAgent>;
  ClientToolAgent: DurableObjectNamespace<ClientToolAgent>;
  SlowAgent: DurableObjectNamespace<SlowAgent>;
  BadKeyAgent: DurableObjectNamespace<BadKeyAgent>;
  AI: Ai;
  OPENAI_API_KEY: string;
};

/**
 * Simple agent that returns plain text — used by the basic protocol tests.
 */
export class ChatAgent extends AIChatAgent<Env> {
  observability = undefined;

  async onChatMessage() {
    return new Response("Hello from e2e agent!", {
      headers: { "Content-Type": "text/plain" }
    });
  }
}

/**
 * LLM-backed agent using Workers AI with streamText.
 * Used by the LLM e2e tests that verify real SSE streaming, tool calls, etc.
 */
export class LlmChatAgent extends AIChatAgent<Env> {
  observability = undefined;

  async onChatMessage(_onFinish?: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const tools = {
      getWeather: tool({
        description: "Get the current weather for a city",
        inputSchema: z.object({
          city: z.string().describe("The city name")
        }),
        execute: async ({ city }) => ({
          city,
          temperature: 22,
          condition: "Sunny"
        })
      }),
      addNumbers: tool({
        description: "Add two numbers together",
        inputSchema: z.object({
          a: z.number().describe("First number"),
          b: z.number().describe("Second number")
        }),
        execute: async ({ a, b }) => ({
          result: a + b
        })
      }),
      ...createToolsFromClientSchemas(options?.clientTools)
    };

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a helpful test assistant. Keep responses very short (1-2 sentences max). " +
        "When asked about the weather, use the getWeather tool. " +
        "When asked to add numbers, use the addNumbers tool.",
      messages: await convertToModelMessages(this.messages),
      tools,
      stopWhen: stepCountIs(3)
    });

    return result.toUIMessageStreamResponse();
  }
}

/**
 * Agent with a client-side tool (no execute function).
 * The LLM calls the tool, the stream pauses at tool-input-available,
 * and the test must send CF_AGENT_TOOL_RESULT to continue.
 */
export class ClientToolAgent extends AIChatAgent<Env> {
  observability = undefined;

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a test assistant. Always use the getUserLocation tool when asked about location.",
      messages: await convertToModelMessages(this.messages),
      tools: {
        getUserLocation: tool({
          description: "Get the user's current location from the browser",
          inputSchema: z.object({})
          // No execute — client must handle via CF_AGENT_TOOL_RESULT
        })
      },
      stopWhen: stepCountIs(3)
    });

    return result.toUIMessageStreamResponse();
  }
}

/**
 * Agent that returns a slow, multi-chunk plain text response.
 * Used to test stream resumption by disconnecting mid-stream.
 */
export class SlowAgent extends AIChatAgent<Env> {
  observability = undefined;

  async onChatMessage() {
    // Create a stream that sends chunks with delays
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const chunks = [
          "chunk-1 ",
          "chunk-2 ",
          "chunk-3 ",
          "chunk-4 ",
          "chunk-5"
        ];
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
          await new Promise((r) => setTimeout(r, 400));
        }
        controller.close();
      }
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/plain" }
    });
  }
}

/**
 * Agent configured with a bad API key to test error handling.
 */
export class BadKeyAgent extends AIChatAgent<Env> {
  observability = undefined;

  async onChatMessage() {
    const openai = createOpenAI({ apiKey: "sk-invalid-key-for-testing" });

    const result = streamText({
      model: openai.chat("gpt-4o-mini"),
      system: "You are a test assistant.",
      messages: await convertToModelMessages(this.messages)
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
