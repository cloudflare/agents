import type { ModelRequest, ChatMessage } from "../types";

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

export function parseModel(m: string): string {
  // Accept "openai:gpt-4o-mini" style or raw "gpt-4o-mini"
  const idx = m.indexOf(":");
  return idx >= 0 ? m.slice(idx + 1) : m;
}

export * from "./openai";
export * from "./anthropic";
export * from "./workers-ai";
