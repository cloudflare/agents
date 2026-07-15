/**
 * Provider-facing message shape. Defined here (not in domain/messages) so
 * that ports never import domain — domain/messages/model.ts imports this
 * type back and builds the richer ChatMessage/conversion layer on top of it.
 */
export type ModelMessage =
  | { role: "system"; content: string }
  | {
      role: "user";
      content: Array<{ type: "text"; text: string } | { type: "file"; mediaType: string; data: string }>;
    }
  | {
      role: "assistant";
      content: Array<
        { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      >;
    }
  | {
      role: "tool";
      content: Array<{
        type: "tool-result";
        toolCallId: string;
        toolName: string;
        output: unknown;
        isError?: boolean;
      }>;
    };

/** Minimal tool description the model sees — no execute function. */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ModelCallSettings {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  maxRetries?: number;
  headers?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
}

export interface ModelRequest {
  system?: string;
  messages: ModelMessage[];
  tools: ToolDescriptor[];
  toolChoice?: "auto" | "none" | { toolName: string };
  settings?: ModelCallSettings;
  signal?: AbortSignal;
}

/** A stream of typed chunks coming back from the model. */
export type ModelChunk =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "error"; error: unknown }
  | {
      type: "finish";
      finishReason: "stop" | "tool-calls" | "length" | "error" | "content-filter";
      usage?: { inputTokens?: number; outputTokens?: number };
    };

export interface ModelClient {
  stream(request: ModelRequest): AsyncIterable<ModelChunk>;
}

/** String ids are resolved to a ModelClient by the app layer. */
export type LanguageModelRef = ModelClient | string;
