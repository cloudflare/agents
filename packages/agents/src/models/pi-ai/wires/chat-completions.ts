/**
 * Chat-completions wire: Workers AI on the run path, and any pi-ai model whose
 * `api` is `openai-completions` on AI Gateway's universal endpoint.
 *
 * The request is shaped with pi-ai's own message converter so replay rules
 * (tool-call id normalization, reasoning replay, role bridging) match pi's
 * other OpenAI-compatible providers. Workers AI then runs through the shared
 * compat layer, which absorbs its native events, heartbeats, per-delta usage
 * and per-family request quirks so the parser below only ever sees strict
 * OpenAI chunks. A vendor model brings its own `compat` profile and needs none
 * of that: its bytes are already what its author says they are.
 */

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ThinkingContent,
  type ToolCall,
  createAssistantMessageEventStream,
  parseStreamingJson
} from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import {
  type CompatWarning,
  normalizeChatCompletion,
  normalizeChatCompletionsStream,
  prepareChatCompletionsRequest
} from "../../core/chat-completions";
import { sseDataStream } from "../../core/sse";
import type { Transport } from "../../core/transport";
import { CLOUDFLARE_AI_API, wireModelId } from "../catalog";
import { assertOk, failStream } from "../errors";
import {
  type OpenAIUsage,
  attachCorrelation,
  correlationDetails,
  openAIVendorHeaders,
  responseInfo,
  sendUniversal,
  startMessage,
  usageFromOpenAI,
  withIdleDeadline,
  recordWarnings
} from "./shared";
import type { WireRequest } from "../settings";

type Compat = Parameters<typeof convertMessages>[2];

/**
 * pi-ai's message converter wants a fully resolved compat profile. This is
 * the strict OpenAI profile: replayed reasoning goes to `reasoning_content`,
 * `max_tokens` is the cap, and nothing vendor-specific is applied here — the
 * shared compat layer handles that per model afterwards.
 */
const STRICT_OPENAI_COMPAT: Compat = {
  chatTemplateKwargs: {},
  maxTokensField: "max_tokens",
  openRouterRouting: {},
  requiresAssistantAfterToolResult: false,
  requiresReasoningContentOnAssistantMessages: false,
  requiresThinkingAsText: false,
  requiresToolResultName: false,
  sendSessionAffinityHeaders: false,
  supportsDeveloperRole: false,
  supportsLongCacheRetention: false,
  supportsReasoningEffort: true,
  supportsStore: false,
  supportsStrictMode: false,
  supportsUsageInStreaming: true,
  thinkingFormat: "openai",
  vercelGatewayRouting: {},
  zaiToolStream: false
};

/** Diagnostic type under which compat-layer warnings are recorded. */
export { COMPAT_DIAGNOSTIC } from "./shared";

interface ToolCallDelta {
  index?: number;
  id?: string | null;
  function?: { name?: string | null; arguments?: string | null };
}

interface ChoiceDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  reasoning_text?: string | null;
  tool_calls?: ToolCallDelta[];
}

/**
 * The fields an OpenAI-compatible endpoint puts reasoning in, in pi-ai's own
 * order (`dist/api/openai-completions.js`). The first non-empty one wins and
 * the rest are skipped: some endpoints send the same text under two spellings,
 * and reading both would double the thinking block.
 */
const REASONING_FIELDS = [
  "reasoning_content",
  "reasoning",
  "reasoning_text"
] as const;

interface Choice {
  delta?: ChoiceDelta;
  message?: ChoiceDelta;
  finish_reason?: string | null;
}

interface Chunk {
  id?: string;
  model?: string;
  choices?: Choice[];
  usage?: OpenAIUsage;
  error?: { message?: string; type?: string };
}

type TextBlock = { type: "text"; text: string };
type ToolCallBlock = ToolCall & { partialArguments?: string };
type Block = TextBlock | ThinkingContent | ToolCallBlock;

function mapFinishReason(reason: string): AssistantMessage["stopReason"] {
  switch (reason) {
    case "stop":
    case "eos":
      return "stop";
    case "length":
    case "model_length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "toolUse";
    default:
      return "error";
  }
}

function convertTools(tools: NonNullable<Context["tools"]>) {
  return tools.map((tool) => ({
    function: {
      description: tool.description,
      name: tool.name,
      parameters: tool.parameters
    },
    type: "function" as const
  }));
}

/** Whether a tool-call chunk is the null finalizer some vLLM parsers emit. */
function isFinalizer(call: ToolCallDelta): boolean {
  const fn = call.function;
  return (
    call.index === undefined &&
    (call.id === null || call.id === undefined) &&
    (fn?.name === null || fn?.name === undefined) &&
    (fn?.arguments === null ||
      fn?.arguments === undefined ||
      fn?.arguments === "")
  );
}

/**
 * Incremental state for one streamed completion: the blocks being built on
 * the assistant message and the events that announce them.
 */
class CompletionAssembler {
  private textBlock: TextBlock | undefined;
  private thinkingBlock: ThinkingContent | undefined;
  private readonly openToolCalls = new Map<number, ToolCallBlock>();
  private readonly closedToolCalls = new Set<number>();
  private lastToolIndex: number | undefined;
  private readonly blocks: Block[];

  constructor(
    private readonly model: Model<string>,
    private readonly output: AssistantMessage,
    private readonly stream: AssistantMessageEventStream
  ) {
    this.blocks = output.content as Block[];
  }

  private indexOf(block: Block): number {
    return this.blocks.indexOf(block);
  }

  stripScratch(): void {
    for (const block of this.blocks) {
      if (block.type === "toolCall") delete block.partialArguments;
    }
  }

  private endText(): void {
    if (this.textBlock === undefined) return;
    this.stream.push({
      content: this.textBlock.text,
      contentIndex: this.indexOf(this.textBlock),
      partial: this.output,
      type: "text_end"
    });
    this.textBlock = undefined;
  }

  private endThinking(): void {
    if (this.thinkingBlock === undefined) return;
    this.stream.push({
      content: this.thinkingBlock.thinking,
      contentIndex: this.indexOf(this.thinkingBlock),
      partial: this.output,
      type: "thinking_end"
    });
    this.thinkingBlock = undefined;
  }

  private pushText(delta: string): void {
    if (delta.length === 0) return;
    this.endThinking();
    if (this.textBlock === undefined) {
      this.textBlock = { text: "", type: "text" };
      this.blocks.push(this.textBlock);
      this.stream.push({
        contentIndex: this.indexOf(this.textBlock),
        partial: this.output,
        type: "text_start"
      });
    }
    this.textBlock.text += delta;
    this.stream.push({
      contentIndex: this.indexOf(this.textBlock),
      delta,
      partial: this.output,
      type: "text_delta"
    });
  }

  private pushThinking(delta: string, signature: string): void {
    if (delta.length === 0) return;
    this.endText();
    if (this.thinkingBlock === undefined) {
      // The signature names the field the text came back in, so a later turn
      // replays it under that same key rather than as plain text. Workers AI
      // always resolves to `reasoning_content`: the compat layer rewrites its
      // `reasoning` deltas before the assembler sees them.
      this.thinkingBlock = {
        thinking: "",
        thinkingSignature: signature,
        type: "thinking"
      };
      this.blocks.push(this.thinkingBlock);
      this.stream.push({
        contentIndex: this.indexOf(this.thinkingBlock),
        partial: this.output,
        type: "thinking_start"
      });
    }
    this.thinkingBlock.thinking += delta;
    this.stream.push({
      contentIndex: this.indexOf(this.thinkingBlock),
      delta,
      partial: this.output,
      type: "thinking_delta"
    });
  }

  private closeToolCall(index: number): void {
    const block = this.openToolCalls.get(index);
    if (block === undefined || this.closedToolCalls.has(index)) return;
    this.closedToolCalls.add(index);
    block.arguments = parseStreamingJson(block.partialArguments ?? "");
    delete block.partialArguments;
    this.stream.push({
      contentIndex: this.indexOf(block),
      partial: this.output,
      toolCall: block,
      type: "toolcall_end"
    });
  }

  private pushToolCalls(calls: ToolCallDelta[]): void {
    this.endThinking();
    this.endText();
    for (const call of calls) {
      if (isFinalizer(call)) {
        if (this.lastToolIndex !== undefined) {
          this.closeToolCall(this.lastToolIndex);
        }
        continue;
      }
      const name = call.function?.name ?? undefined;
      const args = call.function?.arguments ?? "";
      const index =
        typeof call.index === "number" ? call.index : (this.lastToolIndex ?? 0);
      if (this.closedToolCalls.has(index)) continue;

      let block = this.openToolCalls.get(index);
      if (block === undefined) {
        if (this.lastToolIndex !== undefined && this.lastToolIndex !== index) {
          this.closeToolCall(this.lastToolIndex);
        }
        block = {
          arguments: {},
          id: call.id ?? crypto.randomUUID(),
          name: name ?? "",
          partialArguments: "",
          type: "toolCall"
        };
        this.openToolCalls.set(index, block);
        this.blocks.push(block);
        this.stream.push({
          contentIndex: this.indexOf(block),
          partial: this.output,
          type: "toolcall_start"
        });
      } else {
        if (block.name === "" && name) block.name = name;
        if (call.id) block.id = call.id;
      }
      this.lastToolIndex = index;
      if (args.length > 0) {
        block.partialArguments = (block.partialArguments ?? "") + args;
        block.arguments = parseStreamingJson(block.partialArguments);
        this.stream.push({
          contentIndex: this.indexOf(block),
          delta: args,
          partial: this.output,
          type: "toolcall_delta"
        });
      }
    }
  }

  private applyFinishReason(reason: string | null | undefined): boolean {
    if (reason === null || reason === undefined) return false;
    this.output.stopReason = mapFinishReason(reason);
    if (this.output.stopReason === "error") {
      this.output.errorMessage = `The model stopped with finish_reason "${reason}".`;
    }
    return true;
  }

  /** Applies one strict chunk (or a whole normalized body); true if it carried a finish reason. */
  apply(chunk: Chunk): boolean {
    if (chunk.error !== undefined) {
      this.output.stopReason = "error";
      this.output.errorMessage =
        chunk.error.message ?? "The model reported an error.";
      return true;
    }
    const choice = chunk.choices?.[0];
    if (chunk.id !== undefined) this.output.responseId ??= chunk.id;
    if (
      typeof chunk.model === "string" &&
      chunk.model.length > 0 &&
      chunk.model !== this.model.id
    ) {
      this.output.responseModel ??= chunk.model;
    }
    if (chunk.usage !== undefined) {
      this.output.usage = usageFromOpenAI(this.model, chunk.usage);
    }
    const finished = this.applyFinishReason(choice?.finish_reason);
    const delta = choice?.delta ?? choice?.message;
    if (delta !== undefined) {
      for (const field of REASONING_FIELDS) {
        const value = delta[field];
        if (typeof value === "string" && value.length > 0) {
          this.pushThinking(value, field);
          break;
        }
      }
      if (typeof delta.content === "string") this.pushText(delta.content);
      if (Array.isArray(delta.tool_calls)) {
        // A complete `message` is not a delta: OpenAI's schema gives its
        // `tool_calls` no `index` at all, so array position is the index.
        // Without it every call in a parallel set files under 0, merging into
        // one block. The Workers AI branch is normalized before it gets here
        // and fills the same positional index, so this changes nothing there.
        const complete = choice?.delta === undefined;
        this.pushToolCalls(
          complete
            ? delta.tool_calls.map((call, position) => ({
                ...call,
                index: typeof call.index === "number" ? call.index : position
              }))
            : delta.tool_calls
        );
      }
    }
    return finished;
  }

  /** Closes open blocks and settles the stop reason. */
  finish(sawFinishReason: boolean, sawDone: boolean): void {
    for (const index of this.openToolCalls.keys()) this.closeToolCall(index);
    this.endThinking();
    this.endText();
    const hasToolCalls = this.blocks.some((b) => b.type === "toolCall");
    if (this.output.stopReason === "error") return;
    if (!sawFinishReason) {
      if (sawDone || this.blocks.length > 0) {
        this.output.stopReason = hasToolCalls ? "toolUse" : "stop";
      } else {
        this.output.stopReason = "error";
        this.output.errorMessage =
          "The stream ended before the model produced any output.";
      }
    } else if (this.output.stopReason === "stop" && hasToolCalls) {
      this.output.stopReason = "toolUse";
    }
  }
}

/**
 * Puts the reasoning knobs on a chat-completions body, and reports the ones a
 * model cannot take.
 *
 * Workers AI is the one model family with knobs of ours: `reasoning_effort` on
 * its own three-level scale and `chat_template_kwargs`, both of which the
 * compat layer re-checks against the quirk table afterwards. For every other
 * model the decision is the model author's, read off the merged compat profile
 * exactly as pi-ai's own `openai-completions` implementation reads it: the
 * effort is emitted only when the model reasons, declares
 * `supportsReasoningEffort` and asks for OpenAI's `reasoning_effort` shape,
 * and it is remapped through the model's own `thinkingLevelMap`.
 */
function applyReasoning(
  strict: Record<string, unknown>,
  context: {
    model: Model<string>;
    compat: Compat;
    effort: string | null | undefined;
    chatTemplateKwargs: Record<string, unknown> | undefined;
    workersAI: boolean;
  }
): CompatWarning[] {
  const { chatTemplateKwargs, compat, effort, model, workersAI } = context;
  if (workersAI) {
    if (effort !== undefined) strict.reasoning_effort = effort;
    if (chatTemplateKwargs !== undefined) {
      strict.chat_template_kwargs = chatTemplateKwargs;
    }
    return [];
  }

  const ignored: CompatWarning[] = [];
  const thinkingFormat = (compat as { thinkingFormat?: string }).thinkingFormat;
  if (typeof effort === "string") {
    if (
      model.reasoning === true &&
      (compat as { supportsReasoningEffort?: boolean })
        .supportsReasoningEffort !== false &&
      thinkingFormat === "openai"
    ) {
      const map = model.thinkingLevelMap as
        | Record<string, string | null | undefined>
        | undefined;
      strict.reasoning_effort = map?.[effort] ?? effort;
    } else if (thinkingFormat !== "openai") {
      ignored.push({
        feature: "reasoning-effort",
        message: `This model declares the "${thinkingFormat}" thinking format, which this wire does not build; its reasoning level was dropped. Reach it through pi-ai's own provider if you need that shape.`
      });
    }
  } else if (effort === null) {
    ignored.push({
      feature: "reasoning-off",
      message:
        "`reasoningEffort: null` is a Workers AI setting; a model routed through AI Gateway decides its own reasoning, so it was dropped."
    });
  }
  if (chatTemplateKwargs !== undefined) {
    ignored.push({
      feature: "chat-template-kwargs",
      message:
        "`chatTemplateKwargs` is a Workers AI setting and does not apply to a model routed through AI Gateway; it was dropped."
    });
  }
  return ignored;
}

/** Streams a chat-completions request and maps it onto pi-ai events. */
export function streamCompletions(
  request: WireRequest,
  transport: Transport
): AssistantMessageEventStream {
  const { model, context, options, resolved } = request;
  const stream = createAssistantMessageEventStream();
  const output = startMessage(model);
  const assembler = new CompletionAssembler(model, output, stream);

  const workersAI = model.api === CLOUDFLARE_AI_API;

  void (async () => {
    let response: Response | undefined;
    try {
      // A vendor model's own compat profile wins: its author knows which
      // fields that endpoint accepts, and this module deliberately does not.
      const compat: Compat = workersAI
        ? STRICT_OPENAI_COMPAT
        : { ...STRICT_OPENAI_COMPAT, ...(model.compat ?? {}) };
      const messages = convertMessages(
        // Only provider/id/reasoning are read; the api marker is not.
        model as unknown as Model<"openai-completions">,
        context,
        compat
      );

      const strict: Record<string, unknown> = {
        messages,
        stream: true,
        stream_options: { include_usage: true }
      };
      // The run path names the model in the call; the universal request names
      // it in the body, in the vendor's own spelling.
      if (!workersAI) strict.model = wireModelId(model);
      if (context.tools !== undefined && context.tools.length > 0) {
        strict.tools = convertTools(context.tools);
      }
      if (request.toolChoice !== undefined) {
        strict.tool_choice = request.toolChoice;
      }
      if (options.maxTokens !== undefined)
        strict.max_tokens = options.maxTokens;
      if (options.temperature !== undefined) {
        strict.temperature = options.temperature;
      }
      const ignored = applyReasoning(strict, {
        chatTemplateKwargs: resolved.chatTemplateKwargs,
        compat,
        effort: request.reasoningEffort,
        model,
        workersAI
      });
      const sampling = (options as { samplingParams?: Record<string, unknown> })
        .samplingParams;
      if (sampling !== undefined) Object.assign(strict, sampling);

      const prepared = workersAI
        ? prepareChatCompletionsRequest(strict, model.id)
        : { body: strict, reasoningOff: false, warnings: [] };
      recordWarnings(output, [...ignored, ...prepared.warnings]);
      const overridden = await options.onPayload?.(prepared.body, model);
      const payload =
        overridden === undefined
          ? prepared.body
          : (overridden as Record<string, unknown>);

      response = workersAI
        ? await transport.run({
            gateway: resolved.gateway,
            headers: request.headers,
            input: payload,
            model: model.id,
            signal: options.signal
          })
        : await sendUniversal(
            request,
            transport,
            payload,
            openAIVendorHeaders()
          );
      await options.onResponse?.(responseInfo(response), model);
      attachCorrelation(
        output,
        correlationDetails(request, response, transport)
      );
      await assertOk(response, {
        model: model.id,
        requestBodyValues: payload,
        url: transport.url
      });
      if (response.body === null) {
        throw new Error("The model returned an empty response body.");
      }

      stream.push({ partial: output, type: "start" });

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        let sawFinishReason = false;
        let sawDone = false;
        const decoded = withIdleDeadline(
          response.body,
          request.streamIdleTimeoutMs
        ).pipeThrough(sseDataStream());
        const chunks = workersAI
          ? decoded.pipeThrough(
              normalizeChatCompletionsStream(model.id, {
                reasoningOff: prepared.reasoningOff
              })
            )
          : decoded;
        const reader = chunks.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value === "[DONE]") {
              sawDone = true;
              continue;
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(value);
            } catch {
              continue;
            }
            if (parsed === null || typeof parsed !== "object") continue;
            sawFinishReason =
              assembler.apply(parsed as Chunk) || sawFinishReason;
          }
        } finally {
          reader.releaseLock();
        }
        assembler.finish(sawFinishReason, sawDone);
      } else {
        // A complete JSON body came back for a streaming request. Emit it as
        // a one-shot stream rather than failing.
        const body = await response.json();
        const json = workersAI
          ? normalizeChatCompletion(body, model.id)
          : (body as Chunk);
        assembler.finish(assembler.apply(json as Chunk), true);
      }

      if (options.signal?.aborted) throw new Error("Request was aborted.");
      if (output.stopReason === "error") {
        throw new Error(
          output.errorMessage ?? "The model reported an error stop reason."
        );
      }
      stream.push({
        message: output,
        reason: output.stopReason as "stop" | "length" | "toolUse",
        type: "done"
      });
      stream.end(output);
    } catch (error) {
      if (response?.body !== null && response?.body?.locked === false) {
        void response.body.cancel().catch(() => {});
      }
      assembler.stripScratch();
      failStream(stream, output, error, options.signal);
    }
  })();

  return stream;
}
