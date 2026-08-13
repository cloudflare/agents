/**
 * MockLanguageModel: deterministic, scriptable, streams chunks — exercises
 * the identical architecture paths as a real provider (chunk streaming, tool
 * calls, finish reasons, error classification) with zero nondeterminism.
 *
 * Behavior is a list of scripted outputs consumed one generate() call at a
 * time, or a function of the request for reactive scripts.
 */

import type {
  FinishReason,
  LanguageModel,
  LanguageModelOutput,
  LanguageModelRequest,
  LanguageModelStreamChunk,
  Part
} from "../contract";

export type MockScript =
  | readonly LanguageModelOutput[]
  | ((req: LanguageModelRequest, call: number) => LanguageModelOutput);

export function mockOutput(parts: readonly Part[], finish: FinishReason): LanguageModelOutput {
  return { parts, finish, usage: { inputTokens: 10, outputTokens: 10 } };
}

export function mockText(text: string): LanguageModelOutput {
  return mockOutput([{ type: "text", text }], "stop");
}

export function mockToolCall(
  callId: string,
  name: string,
  input: Record<string, string | number>
): LanguageModelOutput {
  return mockOutput([{ type: "tool-call", callId, name, input }], "tool-calls");
}

export class MockLanguageModel implements LanguageModel {
  private calls = 0;
  readonly requests: LanguageModelRequest[] = [];

  constructor(private readonly script: MockScript) {}

  async generate(
    req: LanguageModelRequest,
    io: {
      onChunk?: (chunk: LanguageModelStreamChunk) => void;
      signal?: AbortSignal;
    }
  ): Promise<LanguageModelOutput> {
    if (io.signal?.aborted) throw new Error("aborted");
    this.requests.push(req);
    const call = this.calls++;
    const output =
      typeof this.script === "function"
        ? this.script(req, call)
        : this.script[Math.min(call, this.script.length - 1)];
    if (output === undefined) {
      throw new Error(`mock script exhausted at call ${call}`);
    }
    for (const part of output.parts) {
      if (part.type === "text") {
        for (const word of part.text.split(/(?<= )/)) {
          io.onChunk?.({ type: "text-delta", delta: word });
        }
      } else if (part.type === "tool-call") {
        io.onChunk?.({
          type: "tool-call",
          callId: part.callId,
          name: part.name,
          input: part.input
        });
      }
    }
    return output;
  }

  classifyError(error: unknown): "context-overflow" | "rate-limit" | "transient" | "fatal" {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("overflow")) return "context-overflow";
    if (message.includes("429")) return "rate-limit";
    if (message.includes("transient")) return "transient";
    return "fatal";
  }
}
