/**
 * Workers AI LanguageModel: a real adapter over the `env.AI` binding's chat
 * completion shape (OpenAI-compatible messages + function tools).
 *
 * Typed structurally against a minimal AiBinding so this package needs no
 * dependency on workers-types; in a Worker, pass `env.AI` directly. The
 * binding's non-streaming run() is used — output is re-chunked to onChunk so
 * live streaming works identically to a natively streaming provider; swapping
 * in the streaming API is an adapter-internal upgrade.
 *
 * classifyError is the port obligation: this adapter owns the knowledge of
 * what each provider failure looks like (replacing regex-over-error-message
 * scattered in callers).
 */

import type {
  Json,
  LanguageModel,
  LanguageModelErrorKind,
  LanguageModelOutput,
  LanguageModelRequest,
  LanguageModelStreamChunk,
  Part
} from "../contract";

/** Structural subset of the Workers AI binding. */
export interface AiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
}

export interface WorkersAiOptions {
  readonly model?: string;
  /** Passed through to AI.run inputs (temperature, max_tokens, ...). */
  readonly inputs?: Record<string, unknown>;
}

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

interface WorkersAiToolCall {
  id?: string;
  name?: string;
  arguments?: unknown;
  function?: { name?: string; arguments?: unknown };
}

interface WorkersAiResponse {
  response?: string;
  tool_calls?: WorkersAiToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class WorkersAiLanguageModel implements LanguageModel {
  private readonly model: string;

  constructor(
    private readonly ai: AiBinding,
    private readonly options: WorkersAiOptions = {}
  ) {
    this.model = options.model ?? DEFAULT_MODEL;
  }

  async generate(
    req: LanguageModelRequest,
    io: {
      onChunk?: (chunk: LanguageModelStreamChunk) => void;
      signal?: AbortSignal;
    }
  ): Promise<LanguageModelOutput> {
    if (io.signal?.aborted) throw new Error("aborted before generate");

    const messages: Array<Record<string, unknown>> = [];
    if (req.system !== undefined) {
      messages.push({ role: "system", content: req.system });
    }
    for (const message of req.messages) {
      messages.push(...toProviderMessages(message.role, message.parts));
    }

    const inputs: Record<string, unknown> = {
      ...this.options.inputs,
      messages
    };
    if (req.tools !== undefined && req.tools.length > 0) {
      inputs.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.input
      }));
    }

    const raw = (await this.ai.run(this.model, inputs)) as WorkersAiResponse;

    const parts: Part[] = [];
    if (typeof raw.response === "string" && raw.response.length > 0) {
      io.onChunk?.({ type: "text-delta", delta: raw.response });
      parts.push({ type: "text", text: raw.response });
    }
    const toolCalls = raw.tool_calls ?? [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const name = tc.name ?? tc.function?.name ?? "";
      const args = tc.arguments ?? tc.function?.arguments ?? {};
      const input = (typeof args === "string" ? JSON.parse(args) : args) as Json;
      const callId = tc.id ?? `wai-${i}-${Math.random().toString(36).slice(2, 10)}`;
      io.onChunk?.({ type: "tool-call", callId, name, input });
      parts.push({ type: "tool-call", callId, name, input });
    }

    return {
      parts,
      finish: toolCalls.length > 0 ? "tool-calls" : "stop",
      usage: {
        ...(raw.usage?.prompt_tokens !== undefined
          ? { inputTokens: raw.usage.prompt_tokens }
          : {}),
        ...(raw.usage?.completion_tokens !== undefined
          ? { outputTokens: raw.usage.completion_tokens }
          : {})
      }
    };
  }

  classifyError(error: unknown): LanguageModelErrorKind {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (
      message.includes("context") &&
      (message.includes("length") || message.includes("window") || message.includes("token"))
    ) {
      return "context-overflow";
    }
    if (message.includes("429") || message.includes("rate limit") || message.includes("capacity")) {
      return "rate-limit";
    }
    if (
      message.includes("timeout") ||
      message.includes("network") ||
      message.includes("fetch failed") ||
      message.includes("500") ||
      message.includes("502") ||
      message.includes("503")
    ) {
      return "transient";
    }
    return "fatal";
  }
}

/**
 * Map our Part vocabulary onto OpenAI-compatible chat messages. Tool results
 * travel as role:"tool" provider messages regardless of the carrier role in
 * our log (the Part vocabulary has no tool role — contract finding).
 */
function toProviderMessages(
  role: "user" | "assistant" | "system",
  parts: readonly Part[]
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const texts: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type === "text" || part.type === "reasoning") {
      texts.push(part.type === "text" ? part.text : "");
    } else if (part.type === "tool-call") {
      calls.push({
        id: part.callId,
        type: "function",
        function: { name: part.name, arguments: JSON.stringify(part.input) }
      });
    } else if (part.type === "tool-result") {
      out.push({
        role: "tool",
        tool_call_id: part.callId,
        content:
          typeof part.output === "string" ? part.output : JSON.stringify(part.output)
      });
    }
  }
  const text = texts.join("");
  if (text.length > 0 || calls.length > 0) {
    const message: Record<string, unknown> = { role, content: text };
    if (calls.length > 0) message.tool_calls = calls;
    out.unshift(message);
  }
  return out;
}
