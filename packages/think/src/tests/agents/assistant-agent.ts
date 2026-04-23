/**
 * Test agent for Think integration tests (WebSocket protocol).
 *
 * Uses a mock model that streams "Hello from assistant".
 */

import type { LanguageModel, UIMessage } from "ai";
import { Think } from "../../think";

let _callCount = 0;

function createAssistantMockModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-assistant",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      _callCount++;
      const callId = _callCount;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: `t-${callId}` });
          controller.enqueue({
            type: "text-delta",
            id: `t-${callId}`,
            delta: "Hello from assistant"
          });
          controller.enqueue({ type: "text-end", id: `t-${callId}` });
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

export class TestAssistantAgentAgent extends Think {
  getModel(): LanguageModel {
    return createAssistantMockModel();
  }

  override async getMessages(): Promise<UIMessage[]> {
    return this.messages;
  }
}
