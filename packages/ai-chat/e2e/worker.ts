import {
  AIChatAgent,
  type OnChatMessageOptions,
  type ResponseResult,
  createToolsFromClientSchemas
} from "../src/index";
import type { UIMessage } from "ai";
import { streamText, tool, convertToModelMessages, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { routeAgentRequest } from "agents";

export type Env = {
  ChatAgent: DurableObjectNamespace<ChatAgent>;
  LlmChatAgent: DurableObjectNamespace<LlmChatAgent>;
  ClientToolAgent: DurableObjectNamespace<ClientToolAgent>;
  SlowAgent: DurableObjectNamespace<SlowAgent>;
  BadKeyAgent: DurableObjectNamespace<BadKeyAgent>;
  SanitizeAgent: DurableObjectNamespace<SanitizeAgent>;
  MaxPersistedAgent: DurableObjectNamespace<MaxPersistedAgent>;
  DataPartsAgent: DurableObjectNamespace<DataPartsAgent>;
  ResponseLlmAgent: DurableObjectNamespace<ResponseLlmAgent>;
  ResponseChainAgent: DurableObjectNamespace<ResponseChainAgent>;
  AI: Ai;
  OPENAI_API_KEY: string;
};

/**
 * Simple agent that returns plain text — used by the basic protocol tests.
 */
export class ChatAgent extends AIChatAgent<Env> {
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
      model: workersai("@cf/moonshotai/kimi-k2.5", {
        sessionAffinity: this.sessionAffinity
      }),
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
  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.5", {
        sessionAffinity: this.sessionAffinity
      }),
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

/**
 * Agent that overrides sanitizeMessageForPersistence to redact a field.
 * Used to test that the hook is applied during persistence.
 */
export class SanitizeAgent extends AIChatAgent<Env> {
  protected sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (part.type === "text" && part.text.includes("[SECRET]")) {
          return {
            ...part,
            text: part.text.replace(/\[SECRET\]/g, "[REDACTED]")
          };
        }
        return part;
      })
    };
  }

  async onChatMessage() {
    return new Response("Reply with [SECRET] data included", {
      headers: { "Content-Type": "text/plain" }
    });
  }
}

/**
 * Agent with maxPersistedMessages=4 for testing message trimming.
 */
export class MaxPersistedAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 4;

  async onChatMessage() {
    return new Response("Acknowledged", {
      headers: { "Content-Type": "text/plain" }
    });
  }
}

/**
 * Agent that returns a custom SSE stream including data-* parts.
 * Used to test transient and persistent data part handling.
 */
export class DataPartsAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const lines = [
          'data: {"type":"start"}\n\n',
          'data: {"type":"start-step"}\n\n',
          'data: {"type":"text-start"}\n\n',
          'data: {"type":"text-delta","delta":"Hello from data agent"}\n\n',
          'data: {"type":"text-end"}\n\n',
          'data: {"type":"data-progress","id":"p1","data":{"percent":50},"transient":true}\n\n',
          'data: {"type":"data-result","id":"r1","data":{"answer":42}}\n\n',
          'data: {"type":"finish-step"}\n\n',
          'data: {"type":"finish","finishReason":"stop"}\n\n'
        ];
        for (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      }
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" }
    });
  }
}

/**
 * LLM-backed agent that records onResponse calls.
 * Used by the onResponse e2e tests that verify the hook fires with a real model.
 * Also supports server-initiated streams via saveMessages + onRequest RPC.
 */
export class ResponseLlmAgent extends AIChatAgent<Env> {
  private _responseResults: ResponseResult[] = [];

  async onChatMessage(_onFinish?: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.5", {
        sessionAffinity: this.sessionAffinity
      }),
      system: "You are a test assistant. Keep responses to 1 sentence max.",
      messages: await convertToModelMessages(this.messages),
      abortSignal: options?.abortSignal,
      stopWhen: stepCountIs(2)
    });

    return result.toUIMessageStreamResponse();
  }

  protected async onResponse(result: ResponseResult) {
    this._responseResults.push(result);
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/response-results")) {
      return Response.json(this._responseResults);
    }

    if (
      url.pathname.endsWith("/trigger-server-message") &&
      request.method === "POST"
    ) {
      const body = (await request.json()) as { text: string };
      const userMessage: UIMessage = {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: body.text }]
      };
      await this.saveMessages([...this.messages, userMessage]);
      return new Response("ok");
    }

    return super.onRequest(request);
  }
}

/**
 * LLM-backed agent that calls saveMessages from inside onResponse.
 * Proves the hook fires outside the turn lock — saveMessages queues
 * a follow-up turn that produces a second real LLM response.
 */
export class ResponseChainAgent extends AIChatAgent<Env> {
  private _responseResults: ResponseResult[] = [];
  private _shouldChain = false;

  async onChatMessage(_onFinish?: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.5", {
        sessionAffinity: this.sessionAffinity
      }),
      system: "You are a test assistant. Keep responses to 1 sentence max.",
      messages: await convertToModelMessages(this.messages),
      abortSignal: options?.abortSignal,
      stopWhen: stepCountIs(2)
    });

    return result.toUIMessageStreamResponse();
  }

  protected async onResponse(result: ResponseResult) {
    this._responseResults.push(result);

    if (this._shouldChain) {
      this._shouldChain = false;
      const followUp: UIMessage = {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Now say goodbye in one word." }]
      };
      await this.saveMessages([...this.messages, followUp]);
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/response-results")) {
      return Response.json(this._responseResults);
    }

    if (url.pathname.endsWith("/enable-chain")) {
      this._shouldChain = true;
      return new Response("ok");
    }

    if (url.pathname.endsWith("/get-persisted")) {
      return Response.json(this.messages);
    }

    return super.onRequest(request);
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
