/**
 * Mock LLM Provider for testing the agent system.
 *
 * Allows configuring canned responses, simulating tool calls,
 * and tracking invocations for assertions.
 */

import type { Provider, ModelResult } from "../../sys/providers";
import type { ModelRequest, ChatMessage, ToolCall } from "../../sys/types";

export interface MockResponse {
  /** Text content to return */
  content?: string;
  /** Tool calls to return (simulates model requesting tool use) */
  toolCalls?: ToolCall[];
  /** Simulate an error */
  error?: Error;
  /** Delay before responding (ms) */
  delay?: number;
}

export interface MockProviderOptions {
  /** Default response when no specific response is configured */
  defaultResponse?: MockResponse;
  /** Queue of responses to return in order */
  responseQueue?: MockResponse[];
  /** Map of trigger phrases to responses */
  triggers?: Map<string, MockResponse>;
}

export interface ProviderCall {
  request: ModelRequest;
  timestamp: number;
  response?: ModelResult;
  error?: Error;
}

/**
 * Creates a mock provider for testing.
 *
 * @example
 * ```ts
 * const { provider, calls, addResponse, reset } = createMockProvider({
 *   defaultResponse: { content: "Hello!" }
 * });
 *
 * // Queue specific responses
 * addResponse({ content: "First response" });
 * addResponse({
 *   toolCalls: [{ id: "1", name: "echo", args: { message: "test" } }]
 * });
 * addResponse({ content: "Final response after tool" });
 *
 * // Use with AgentSystem
 * const system = new AgentSystem({ defaultModel: "mock", provider });
 * ```
 */
export function createMockProvider(options: MockProviderOptions = {}) {
  const calls: ProviderCall[] = [];
  const responseQueue: MockResponse[] = [...(options.responseQueue ?? [])];
  const triggers = new Map(options.triggers ?? []);

  const defaultResponse: MockResponse = options.defaultResponse ?? {
    content: "Mock response"
  };

  function addResponse(response: MockResponse) {
    responseQueue.push(response);
  }

  function addTrigger(phrase: string, response: MockResponse) {
    triggers.set(phrase.toLowerCase(), response);
  }

  function reset() {
    calls.length = 0;
    responseQueue.length = 0;
  }

  function findTriggerResponse(messages: ChatMessage[]): MockResponse | null {
    // Check the last user message for trigger phrases
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user" && "content" in msg) {
        const content = msg.content.toLowerCase();
        for (const [phrase, response] of triggers) {
          if (content.includes(phrase)) {
            return response;
          }
        }
      }
    }
    return null;
  }

  function getNextResponse(req: ModelRequest): MockResponse {
    // 1. Check for trigger phrase matches
    const triggerResponse = findTriggerResponse(req.messages);
    if (triggerResponse) return triggerResponse;

    // 2. Use queued response if available
    if (responseQueue.length > 0) {
      return responseQueue.shift()!;
    }

    // 3. Fall back to default
    return defaultResponse;
  }

  async function processResponse(
    req: ModelRequest,
    response: MockResponse
  ): Promise<ModelResult> {
    // Simulate delay if configured
    if (response.delay) {
      await new Promise((resolve) => setTimeout(resolve, response.delay));
    }

    // Simulate error if configured
    if (response.error) {
      throw response.error;
    }

    // Build the assistant message
    const message: ChatMessage = response.toolCalls?.length
      ? { role: "assistant", toolCalls: response.toolCalls }
      : { role: "assistant", content: response.content ?? "" };

    return {
      message,
      usage: { promptTokens: 100, completionTokens: 50 }
    };
  }

  const provider: Provider = {
    async invoke(req: ModelRequest, _opts) {
      const call: ProviderCall = {
        request: req,
        timestamp: Date.now()
      };

      try {
        const response = getNextResponse(req);
        const result = await processResponse(req, response);
        call.response = result;
        calls.push(call);
        return result;
      } catch (error) {
        call.error = error as Error;
        calls.push(call);
        throw error;
      }
    },

    async stream(req: ModelRequest, onDelta: (chunk: string) => void) {
      const call: ProviderCall = {
        request: req,
        timestamp: Date.now()
      };

      try {
        const response = getNextResponse(req);
        const result = await processResponse(req, response);

        // Simulate streaming by emitting content character by character
        if (
          result.message.role === "assistant" &&
          "content" in result.message
        ) {
          const content = result.message.content;
          for (const char of content) {
            onDelta(char);
            // Small delay between chunks for realism
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }

        call.response = result;
        calls.push(call);
        return result;
      } catch (error) {
        call.error = error as Error;
        calls.push(call);
        throw error;
      }
    }
  };

  return {
    provider,
    calls,
    addResponse,
    addTrigger,
    reset,
    /** Get the last call made to the provider */
    get lastCall(): ProviderCall | undefined {
      return calls[calls.length - 1];
    },
    /** Get total number of calls */
    get callCount(): number {
      return calls.length;
    }
  };
}

// Pre-built response helpers
export const MockResponses = {
  /** Simple text response */
  text: (content: string): MockResponse => ({ content }),

  /** Response with tool calls */
  toolCall: (
    name: string,
    args: Record<string, unknown>,
    id = crypto.randomUUID()
  ): MockResponse => ({
    toolCalls: [{ id, name, args }]
  }),

  /** Multiple tool calls */
  toolCalls: (
    calls: Array<{ name: string; args: Record<string, unknown>; id?: string }>
  ): MockResponse => ({
    toolCalls: calls.map((c) => ({
      id: c.id ?? crypto.randomUUID(),
      name: c.name,
      args: c.args
    }))
  }),

  /** Simulates an error */
  error: (message: string): MockResponse => ({
    error: new Error(message)
  }),

  /** Delayed response */
  delayed: (content: string, delayMs: number): MockResponse => ({
    content,
    delay: delayMs
  })
};

export type MockProvider = ReturnType<typeof createMockProvider>;
