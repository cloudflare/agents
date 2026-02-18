import {
  generateText,
  streamText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type PrepareStepResult
} from "ai";

// ── Context trimming ──────────────────────────────────────────────────

/**
 * Trim the message list when it grows large to avoid hitting model
 * context limits. Keeps the first user message (the original task)
 * plus the most recent messages.
 *
 * Also truncates individual tool results that are excessively long —
 * bash commands can produce thousands of lines of output that waste
 * context on every subsequent step.
 */
const CONTEXT_TRIM_THRESHOLD = 40; // trim when message count exceeds this
const CONTEXT_KEEP_RECENT = 25; // number of recent messages to keep after first
const TOOL_RESULT_MAX_CHARS = 8_000; // per tool-result content truncation

function truncateString(s: string): string {
  if (s.length <= TOOL_RESULT_MAX_CHARS) return s;
  return (
    s.slice(0, TOOL_RESULT_MAX_CHARS) +
    `\n... [truncated ${s.length - TOOL_RESULT_MAX_CHARS} chars]`
  );
}

function trimToolResult(value: unknown): unknown {
  // Plain string
  if (typeof value === "string") return truncateString(value);

  // AI SDK v6 structured text: { type: "text", value: string }
  // or older format:            { type: "text", text: string }
  if (typeof value === "object" && value !== null && "type" in value) {
    const v = value as Record<string, unknown>;
    if (v.type === "text") {
      if (typeof v.value === "string")
        return { ...v, value: truncateString(v.value) };
      if (typeof v.text === "string")
        return { ...v, text: truncateString(v.text) };
    }
  }

  // Array of content parts
  if (Array.isArray(value)) return value.map(trimToolResult);

  return value;
}

function prepareStepFn({
  messages
}: {
  messages: ModelMessage[];
}): PrepareStepResult {
  let trimmed = messages;

  // Trim tool results that are too large regardless of message count.
  // AI SDK v6 uses 'output' for the result value; older builds used 'content'.
  trimmed = trimmed.map((msg) => {
    if (msg.role === "tool") {
      return {
        ...msg,
        content: Array.isArray(msg.content)
          ? (msg.content as Array<Record<string, unknown>>).map((part) => {
              if (part.output !== undefined)
                return { ...part, output: trimToolResult(part.output) };
              if (part.content !== undefined)
                return { ...part, content: trimToolResult(part.content) };
              return part;
            })
          : trimToolResult(msg.content)
      } as ModelMessage;
    }
    return msg;
  });

  // Trim old messages when conversation grows too long.
  // Keep the first USER message (the original task) so the model always
  // has context about what it was asked to do. Fall back to index 0 if no
  // user message exists (shouldn't happen in normal use, but be defensive).
  if (trimmed.length > CONTEXT_TRIM_THRESHOLD) {
    const firstUserIdx = trimmed.findIndex((m) => m.role === "user");
    const anchor = trimmed[firstUserIdx >= 0 ? firstUserIdx : 0];
    trimmed = [anchor, ...trimmed.slice(-CONTEXT_KEEP_RECENT)];
  }

  return { messages: trimmed };
}

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
 * AgentLoop — multi-step LLM execution with streaming support.
 *
 * Three modes:
 * - step(): single LLM call (no tool-call loop)
 * - run(): multi-step loop (generateText + stopWhen), non-streaming
 * - stream(): multi-step loop (streamText + stopWhen), streaming NDJSON
 *
 * NDJSON stream format emitted by stream():
 *   {"t":"text","d":"..."}     — text delta
 *   {"t":"think","d":"..."}    — reasoning delta
 *   {"t":"tool","n":"name","a":{...args}}  — tool call started
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

  /** Single-step generation — no multi-turn tool calling. */
  async step(messages: ModelMessage[]): Promise<StepResult> {
    const result = await generateText({
      model: this._model,
      system: this._system,
      messages,
      tools: this._tools,
      prepareStep: prepareStepFn,
      abortSignal: this._abortSignal
    });

    return this._buildStepResult(result);
  }

  /**
   * Multi-step non-streaming loop.
   * Stops when the model produces text, calls `done`, or hits maxSteps.
   */
  async run(messages: ModelMessage[]): Promise<StepResult> {
    const result = await generateText({
      model: this._model,
      system: this._system,
      messages,
      tools: this._tools,
      stopWhen: stepCountIs(this._maxSteps),
      prepareStep: prepareStepFn,
      abortSignal: this._abortSignal
    });

    return this._buildStepResult(result);
  }

  /**
   * Multi-step streaming loop.
   *
   * Returns a ReadableStream of NDJSON lines and a Promise that resolves to
   * the final StepResult. The stream stays open until all steps complete
   * (including tool execution between steps).
   *
   * Stops when the model produces text, calls `done`, or hits maxSteps.
   */
  stream(messages: ModelMessage[]): StreamResult {
    console.log("[AgentLoop.stream] starting");

    const aiResult = streamText({
      model: this._model,
      system: this._system,
      messages,
      tools: this._tools,
      // IMPORTANT: without stopWhen, streamText only does one step.
      // Tool calls would fire but there'd be no follow-up generation.
      stopWhen: stepCountIs(this._maxSteps),
      prepareStep: prepareStepFn,
      abortSignal: this._abortSignal
    });

    // Track text chunks and any summary from the `done` tool
    const textStream = new ReadableStream<string>({
      async start(controller) {
        let textChunks = 0;
        let toolCalls = 0;
        try {
          for await (const part of aiResult.fullStream) {
            switch (part.type) {
              case "text-delta":
                controller.enqueue(
                  JSON.stringify({ t: "text", d: part.text }) + "\n"
                );
                textChunks++;
                break;
              case "reasoning-delta":
                controller.enqueue(
                  JSON.stringify({ t: "think", d: part.text }) + "\n"
                );
                break;
              case "tool-call":
                // Notify the client what tool is being invoked so it can
                // show a live "🔧 Running readFile /src/index.ts..." indicator.
                controller.enqueue(
                  JSON.stringify({
                    t: "tool",
                    n: part.toolName,
                    a: part.input
                  }) + "\n"
                );
                toolCalls++;
                break;
            }
          }
          console.log(
            `[AgentLoop.stream] done — ${textChunks} text, ${toolCalls} tool calls`
          );
          controller.close();
        } catch (err) {
          console.error("[AgentLoop.stream] error:", err);
          controller.error(err);
        }
      }
    });

    const result = (async (): Promise<StepResult> => {
      const [response, text, usage, reasoning] = await Promise.all([
        aiResult.response,
        aiResult.text,
        aiResult.usage,
        aiResult.reasoningText
      ]);

      // If the model called `done` as its final act and produced no text,
      // extract the summary from the tool call's `input` field.
      //
      // Note: `response.messages` uses the AI SDK's internal message format
      // where tool-call content parts store parsed args in `input` (an object),
      // NOT in `args` (which is our own StepResult field name).
      let finalText = text;
      if (!finalText) {
        const doneCalls = response.messages
          .filter((m) => m.role === "assistant")
          .flatMap((m) =>
            Array.isArray(m.content)
              ? (m.content as Array<Record<string, unknown>>).filter(
                  (p) => p.type === "tool-call" && p.toolName === "done"
                )
              : []
          );
        if (doneCalls.length > 0) {
          // `input` holds the parsed args object in AI SDK's response messages
          const input = doneCalls[0].input as Record<string, unknown>;
          finalText = (input?.summary as string | undefined) ?? "";
        }
      }

      console.log(
        `[AgentLoop.stream] resolved — text=${finalText.length}, reasoning=${reasoning?.length ?? 0}`
      );

      return {
        type: "text",
        text: finalText,
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

    // Attach a no-op catch to prevent a "floating promise" window between
    // when `result` is created and when the caller awaits it after the stream
    // is consumed. Without this, a rejection that occurs while the stream is
    // being read (e.g. AI binding unavailable) would be reported as an
    // unhandled rejection even though the caller will await it shortly after.
    // Errors are still propagated — this just shifts the handling boundary.
    result.catch(() => {});

    return { textStream, result };
  }

  private _buildStepResult(
    result: Awaited<ReturnType<typeof generateText>>
  ): StepResult {
    const toolCalls = (result.toolCalls ?? []).map((tc) => ({
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: (tc as unknown as { input: unknown }).input
    }));

    const toolResults = (result.toolResults ?? []).map((tr) => ({
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      result: (tr as unknown as { output: unknown }).output
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
        promptTokens: result.usage?.inputTokens ?? 0,
        completionTokens: result.usage?.outputTokens ?? 0
      }
    };
  }
}
