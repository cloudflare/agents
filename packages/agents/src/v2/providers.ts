import type { ModelRequest, ChatMessage } from "./types";

// llm/providers.ts
export interface Provider {
  invoke(
    req: ModelRequest,
    opts: { signal?: AbortSignal }
  ): Promise<ModelResult>;
  stream(
    req: ModelRequest,
    onDelta: (chunk: string) => void
  ): Promise<ModelResult>;
}

export type ModelResult = {
  message: ChatMessage; // assistant message (may include tool_calls)
  usage?: { promptTokens: number; completionTokens: number; costUsd?: number };
};

// TODO: implement one of these
export function makeOpenAI(_baseUrl: string, _apiKey: string): Provider {
  /* fetch + SSE parse */
  return {
    invoke: async (_req, _opts) => {
      return { message: { role: "assistant", content: "Hello, world!" } };
    },
    stream: async (_req, _onDelta) => {
      return { message: { role: "assistant", content: "Hello, world!" } };
    }
  };
}
export function makeAnthropic(_baseUrl: string, _apiKey: string): Provider {
  /* SSE parse */
  return {
    invoke: async (_req, _opts) => {
      return { message: { role: "assistant", content: "Hello, world!" } };
    },
    stream: async (_req, _onDelta) => {
      return { message: { role: "assistant", content: "Hello, world!" } };
    }
  };
}
export function makeWorkersAI(_ai: unknown): Provider {
  /* @cloudflare/ai or fetch */
  return {
    invoke: async (_req, _opts) => {
      return { message: { role: "assistant", content: "Hello, world!" } };
    },
    stream: async (_req, _onDelta) => {
      return { message: { role: "assistant", content: "Hello, world!" } };
    }
  };
}
