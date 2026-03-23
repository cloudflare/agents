/**
 * Test agents for the AssistantAgent agentic loop.
 *
 * Uses a mock LanguageModelV3 that works in the Workers runtime
 * without needing a real LLM provider.
 */

import type { LanguageModel, ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { Think } from "../../think";
import type { Session } from "../../session/index";
import type { UIMessage } from "ai";

// ── Mock LanguageModel ──────────────────────────────────────────────

let callCount = 0;

function createMockModel(): LanguageModel {
  callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      callCount++;
      const currentCall = callCount;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({
            type: "text-start",
            id: `text-${currentCall}`
          });
          controller.enqueue({
            type: "text-delta",
            id: `text-${currentCall}`,
            delta: `Response ${currentCall}`
          });
          controller.enqueue({
            type: "text-end",
            id: `text-${currentCall}`
          });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: 5 }
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

function createMockToolModel(): LanguageModel {
  let toolCallCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-tool-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: Record<string, unknown>) {
      toolCallCount++;
      const messages = (options as { prompt?: unknown[] }).prompt ?? [];
      const hasToolResult = messages.some(
        (m: unknown) =>
          typeof m === "object" &&
          m !== null &&
          (m as Record<string, unknown>).role === "tool"
      );

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });

          if (!hasToolResult && toolCallCount === 1) {
            // First call: emit a tool call
            controller.enqueue({
              type: "tool-input-start",
              id: "tc1",
              toolName: "echo"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: "tc1",
              delta: JSON.stringify({ message: "ping" })
            });
            controller.enqueue({
              type: "tool-input-end",
              id: "tc1"
            });
            controller.enqueue({
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 10, outputTokens: 5 }
            });
          } else {
            // Second call (after tool result): emit text
            controller.enqueue({
              type: "text-start",
              id: "t2"
            });
            controller.enqueue({
              type: "text-delta",
              id: "t2",
              delta: "Tool said: pong"
            });
            controller.enqueue({
              type: "text-end",
              id: "t2"
            });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 20, outputTokens: 10 }
            });
          }

          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

// ── Test agent: bare (no getModel override) ─────────────────────────

export class BareAssistantAgent extends Think {
  override getSessions(): Session[] {
    return super.getSessions();
  }

  override createSession(name: string): Session {
    return super.createSession(name);
  }

  override getCurrentSessionId(): string | null {
    return super.getCurrentSessionId();
  }
}

// ── Test agent: uses default loop with mock model ───────────────────

export class LoopTestAgent extends Think {
  getModel(): LanguageModel {
    return createMockModel();
  }

  async getSystemPrompt(): Promise<string> {
    return "You are a test assistant.";
  }

  override getSessions(): Session[] {
    return super.getSessions();
  }

  override createSession(name: string): Session {
    return super.createSession(name);
  }

  override switchSession(sessionId: string): UIMessage[] {
    return super.switchSession(sessionId);
  }

  override getCurrentSessionId(): string | null {
    return super.getCurrentSessionId();
  }

  getMessages(): UIMessage[] {
    return this.messages;
  }

  getSessionHistory(sessionId: string): UIMessage[] {
    return this.sessions.getHistory(sessionId);
  }
}

// ── Test agent: uses default loop with tools ────────────────────────

export class LoopToolTestAgent extends Think {
  getModel(): LanguageModel {
    return createMockToolModel();
  }

  async getSystemPrompt(): Promise<string> {
    return "You are a test assistant with tools.";
  }

  getTools(): ToolSet {
    return {
      echo: tool({
        description: "Echo a message back",
        inputSchema: z.object({ message: z.string() }),
        execute: async ({ message }: { message: string }) => `pong: ${message}`
      })
    };
  }

  getMaxSteps(): number {
    return 3;
  }

  override getSessions(): Session[] {
    return super.getSessions();
  }

  override createSession(name: string): Session {
    return super.createSession(name);
  }

  override switchSession(sessionId: string): UIMessage[] {
    return super.switchSession(sessionId);
  }

  override getCurrentSessionId(): string | null {
    return super.getCurrentSessionId();
  }

  getMessages(): UIMessage[] {
    return this.messages;
  }

  getSessionHistory(sessionId: string): UIMessage[] {
    return this.sessions.getHistory(sessionId);
  }
}
