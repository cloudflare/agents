import { createAgentThread } from "../worker";
import { createHandler } from "../handler";
import type { Provider, ModelResult } from "../providers";
import type { ModelRequest, ChatMessage } from "../types";

export type Env = {
  AGENT_THREAD: DurableObjectNamespace<TestAgentThread>;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
};

/**
 * Mock provider for testing - returns predefined responses
 */
export class MockProvider implements Provider {
  private responses: ChatMessage[] = [];
  private responseIndex = 0;

  constructor(responses: ChatMessage[] = []) {
    this.responses = responses;
  }

  setResponses(responses: ChatMessage[]) {
    this.responses = responses;
    this.responseIndex = 0;
  }

  async invoke(
    _req: ModelRequest,
    _opts: { signal?: AbortSignal }
  ): Promise<ModelResult> {
    // If no predefined responses, return a simple text response
    if (this.responses.length === 0) {
      return {
        message: { role: "assistant", content: "Mock response" },
        usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001 }
      };
    }

    // Use predefined responses in sequence
    const response = this.responses[this.responseIndex % this.responses.length];
    this.responseIndex++;

    return {
      message: response,
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001 }
    };
  }

  async stream(
    _req: ModelRequest,
    _onDelta: (chunk: string) => void
  ): Promise<ModelResult> {
    // For tests, just return invoke result
    return this.invoke(_req, {});
  }
}

// Create a test agent thread with mock provider
const mockProvider = new MockProvider();

export const TestAgentThread = createAgentThread({
  provider: mockProvider,
  middleware: [] // Tests will configure middleware as needed
});

// Export handler
export default createHandler();
