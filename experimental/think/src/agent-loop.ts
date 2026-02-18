import {
  generateText,
  streamText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet
} from "ai";

type BuildableResult = {
  text: string;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: unknown;
  }>;
  toolResults: Array<{
    toolCallId: string;
    toolName: string;
    result: unknown;
  }>;
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number };
  response: { messages: Array<Record<string, unknown>> };
};

// ── Step result types ────────────────────────────────────────────────

export type StepResultType = "text" | "tool-calls-pending" | "error";

export type StepResult = {
  type: StepResultType;
  text: string;
  reasoning?: string;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: unknown;
  }>;
  toolResults: Array<{
    toolCallId: string;
    toolName: string;
    result: unknown;
  }>;
  responseMessages: ModelMessage[];
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number };
};

export type StreamResult = {
  textStream: ReadableStream<string>;
  result: Promise<StepResult>;
};

// ── Options ──────────────────────────────────────────────────────────

export type AgentLoopOptions = {
  model: LanguageModel;
  system?: string;
  tools?: ToolSet;
  abortSignal?: AbortSignal;
  maxSteps?: number;
};

/**
 * AgentLoop — step-at-a-time LLM execution.
 *
 * Standalone class with no DO/facet/transport dependencies.
 * Three modes:
 * - step(): single LLM call (generateText), returns StepResult
 * - run(): multi-step loop (generateText + stopWhen), returns StepResult
 * - stream(): streaming (streamText), returns ReadableStream + Promise<StepResult>
 */
export class AgentLoop {
  private _model: LanguageModel;
  private _system: string | undefined;
  private _tools: ToolSet;
  private _abortSignal: AbortSignal | undefined;
  private _maxSteps: number;

  constructor(options: AgentLoopOptions) {
    this._model = options.model;
    this._system = options.system;
    this._tools = options.tools ?? {};
    this._abortSignal = options.abortSignal;
    this._maxSteps = options.maxSteps ?? 10;
  }

  async step(messages: ModelMessage[]): Promise<StepResult> {
    const result = await generateText({
      model: this._model,
      system: this._system,
      messages,
      tools: this._tools,
      abortSignal: this._abortSignal
    });

    return this._buildStepResult(result as unknown as BuildableResult);
  }

  async run(messages: ModelMessage[]): Promise<StepResult> {
    const result = await generateText({
      model: this._model,
      system: this._system,
      messages,
      tools: this._tools,
      stopWhen: stepCountIs(this._maxSteps),
      abortSignal: this._abortSignal
    });

    return this._buildStepResult(result as unknown as BuildableResult);
  }

  /**
   * Stream a response. Returns a ReadableStream of text deltas
   * (crossable over facet RPC) and a Promise that resolves to
   * the final StepResult after the stream completes.
   */
  stream(messages: ModelMessage[]): StreamResult {
    console.log("[AgentLoop.stream] calling streamText");
    const aiResult = streamText({
      model: this._model,
      system: this._system,
      messages,
      tools: this._tools,
      abortSignal: this._abortSignal
    });

    // Use fullStream to capture both text deltas and reasoning deltas.
    // Each chunk is NDJSON: {"t":"text","d":"..."} or {"t":"think","d":"..."}
    // followed by a newline — so the receiver can parse complete chunks.
    const textStream = new ReadableStream<string>({
      async start(controller) {
        let count = 0;
        try {
          for await (const part of aiResult.fullStream) {
            if (part.type === "text-delta") {
              controller.enqueue(
                JSON.stringify({ t: "text", d: part.text }) + "\n"
              );
              count++;
            } else if (part.type === "reasoning-delta") {
              controller.enqueue(
                JSON.stringify({ t: "think", d: part.text }) + "\n"
              );
            }
          }
          console.log(`[AgentLoop.stream] done, ${count} text chunks`);
          controller.close();
        } catch (err) {
          console.error("[AgentLoop.stream] error:", err);
          controller.error(err);
        }
      }
    });

    const result = (async (): Promise<StepResult> => {
      const response = await aiResult.response;
      const text = await aiResult.text;
      const usage = await aiResult.usage;
      const reasoning = await aiResult.reasoningText;
      console.log(
        `[AgentLoop.stream] done, text=${text.length}, reasoning=${reasoning?.length ?? 0}`
      );
      return {
        type: "text",
        text,
        reasoning: reasoning ?? undefined,
        toolCalls: [],
        toolResults: [],
        responseMessages: response.messages as unknown as ModelMessage[],
        finishReason: "stop",
        usage: {
          promptTokens: usage?.inputTokens ?? 0,
          completionTokens: usage?.outputTokens ?? 0
        }
      };
    })();

    return { textStream, result };
  }

  private _buildStepResult(result: BuildableResult): StepResult {
    const toolCalls = (result.toolCalls ?? []).map((tc) => ({
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: tc.args
    }));

    const toolResults = (result.toolResults ?? []).map((tr) => ({
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      result: tr.result
    }));

    const hasUnexecutedToolCalls =
      toolCalls.length > 0 && toolResults.length < toolCalls.length;

    let type: StepResultType;
    if (result.finishReason === "error") {
      type = "error";
    } else if (hasUnexecutedToolCalls) {
      type = "tool-calls-pending";
    } else {
      type = "text";
    }

    return {
      type,
      text: result.text ?? "",
      toolCalls,
      toolResults,
      responseMessages: result.response.messages as unknown as ModelMessage[],
      finishReason: result.finishReason ?? "unknown",
      usage: {
        promptTokens: result.usage?.promptTokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? 0
      }
    };
  }
}
