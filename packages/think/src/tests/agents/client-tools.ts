/**
 * Test agent for Think client-side tool support.
 *
 * Uses a mock model that emits tool calls on the first invocation
 * and text on subsequent invocations (after tool results are applied).
 */

import type { LanguageModel, UIMessage } from "ai";
import { Think } from "../../think";
import type { ChatResponseResult } from "../../think";
import type { ClientToolSchema } from "agents/chat";

function createClientToolMockModel(): LanguageModel {
  let callCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-client-tool-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream(options: Record<string, unknown>) {
      callCount++;
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

          if (!hasToolResult && callCount === 1) {
            controller.enqueue({
              type: "tool-input-start",
              id: "tc-client-1",
              toolName: "client_action"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: "tc-client-1",
              delta: JSON.stringify({ action: "do_thing" })
            });
            controller.enqueue({
              type: "tool-input-end",
              id: "tc-client-1"
            });
            controller.enqueue({
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 10, outputTokens: 5 }
            });
          } else {
            controller.enqueue({ type: "text-start", id: "t-cont" });
            controller.enqueue({
              type: "text-delta",
              id: "t-cont",
              delta: "Continuation after tool"
            });
            controller.enqueue({ type: "text-end", id: "t-cont" });
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

function createTextOnlyMockModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-text-only",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({
            type: "text-delta",
            id: "t1",
            delta: "Hello"
          });
          controller.enqueue({ type: "text-end", id: "t1" });
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

export class ThinkClientToolsAgent extends Think {
  private _useTextOnly = false;
  private _responseLog: ChatResponseResult[] = [];

  override onChatResponse(result: ChatResponseResult): void {
    this._responseLog.push(result);
  }

  async getResponseLog(): Promise<ChatResponseResult[]> {
    return this._responseLog;
  }

  getModel(): LanguageModel {
    if (this._useTextOnly) return createTextOnlyMockModel();
    return createClientToolMockModel();
  }

  getSystemPrompt(): string {
    return "You are a test assistant with client tools.";
  }

  async setTextOnlyMode(value: boolean): Promise<void> {
    this._useTextOnly = value;
  }

  async getCapturedClientTools(): Promise<ClientToolSchema[] | undefined> {
    return (
      this as unknown as { _lastClientTools: ClientToolSchema[] | undefined }
    )._lastClientTools;
  }

  async persistToolCallMessage(messages: UIMessage[]): Promise<void> {
    for (const msg of messages) {
      await this.session.appendMessage(msg);
    }
  }

  async getBranches(messageId: string): Promise<UIMessage[]> {
    return this.session.getBranches(messageId);
  }
}
