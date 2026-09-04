/**
 * Normalizes a chat-completions SSE stream from the run path into strict
 * OpenAI `chat.completion.chunk` events.
 *
 * Every Workers AI model streams the same three-part hybrid (live captures,
 * all families): OpenAI-shaped delta chunks that each carry a per-delta
 * `usage`, then a `choices: []` heartbeat, then a native
 * `{ response: "", usage }` tail with the cumulative usage, then `[DONE]`.
 * Some models also emit native `{ response: "<text>" }` deltas or top-level
 * `tool_calls`. After this transform a consumer sees only:
 *
 * - delta chunks without per-delta usage and with reasoning under
 *   `reasoning_content`;
 * - at most one final `choices: []` chunk carrying the cumulative usage
 *   (the OpenAI `stream_options.include_usage` shape);
 * - a `finish_reason` on some chunk before the end, synthesized when the
 *   model finished cleanly without sending one;
 * - `[DONE]`.
 *
 * Input and output are SSE `data` payloads (strings), so it slots between the
 * SSE decoder and either framework's OpenAI chunk parser.
 */

import { isWorkersAI, quirksFor } from "./quirks";
import { normalizeToolCall } from "./response";

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const NOISE_FIELDS = [
  "p",
  "token_ids",
  "prompt_token_ids",
  "kv_transfer_params"
];

/** Fields the run path adds to every chunk that mean nothing to a consumer. */
function stripNoise(chunk: Record_): Record_ {
  const out = { ...chunk };
  for (const key of NOISE_FIELDS) delete out[key];
  return out;
}

function stripEchoSuffix(chunk: Record_, modelId: string): Record_ {
  const suffix = quirksFor(modelId).modelEchoSuffix;
  if (suffix === undefined || typeof chunk.model !== "string") return chunk;
  return chunk.model.endsWith(suffix)
    ? { ...chunk, model: chunk.model.slice(0, -suffix.length) }
    : chunk;
}

function normalizeDelta(delta: Record_, relabelReasoning: boolean): Record_ {
  const out: Record_ = { ...delta };
  const reasoning =
    typeof out.reasoning_content === "string" && out.reasoning_content !== ""
      ? out.reasoning_content
      : typeof out.reasoning === "string" && out.reasoning !== ""
        ? out.reasoning
        : undefined;
  delete out.reasoning;
  delete out.reasoning_content;
  if (reasoning !== undefined) {
    if (relabelReasoning) {
      // Reasoning is off, so these tokens are the answer (nemotron-3).
      out.content =
        (typeof out.content === "string" ? out.content : "") + reasoning;
    } else {
      out.reasoning_content = reasoning;
    }
  }
  if (Array.isArray(out.tool_calls)) {
    out.tool_calls = out.tool_calls.map((call, index) => {
      // Fragments and the null finalizer pass through untouched; only a
      // native complete-object call needs lifting into the OpenAI shape.
      if (!isRecord(call)) return call;
      const fn = isRecord(call.function) ? call.function : undefined;
      const args = fn !== undefined ? fn.arguments : call.arguments;
      return isRecord(args) ? (normalizeToolCall(call, index) ?? call) : call;
    });
  }
  return out;
}

export interface StreamNormalizationOptions {
  /** Whether the request turned reasoning off (`PreparedRequest.reasoningOff`). */
  reasoningOff?: boolean;
}

/**
 * The transform. Backpressure is preserved: nothing is buffered except the
 * single pending usage chunk, which must wait for the tail.
 */
export function normalizeChatCompletionsStream(
  modelId: string,
  options: StreamNormalizationOptions = {}
): TransformStream<string, string> {
  const quirks = quirksFor(modelId);
  const relabelReasoning =
    options.reasoningOff === true &&
    quirks.reasoningOffStreamLabel === "reasoning";
  let id: string | undefined;
  let model: string | undefined;
  let created: number | undefined;
  let sawFinishReason = false;
  let sawContent = false;
  let sawToolCalls = false;
  let sawDone = false;
  let finalUsage: unknown;
  let finalUsageTemplate: Record_ | undefined;
  // Workers AI stamps a per-delta usage on every content chunk and sends the
  // cumulative figure in its native tail; other vendors only ever put usage on
  // the final `choices: []` chunk, so theirs is left alone.
  const perDeltaUsage = isWorkersAI(modelId);

  const envelope = (extra: Record_): Record_ => ({
    ...(id !== undefined ? { id } : {}),
    object: "chat.completion.chunk",
    ...(created !== undefined ? { created } : {}),
    ...(model !== undefined ? { model } : {}),
    ...extra
  });

  const emit = (
    controller: TransformStreamDefaultController<string>,
    chunk: Record_
  ) => {
    controller.enqueue(JSON.stringify(chunk));
  };

  const emitTail = (controller: TransformStreamDefaultController<string>) => {
    if (!sawFinishReason && sawDone && (sawContent || sawToolCalls)) {
      emit(
        controller,
        envelope({
          choices: [
            {
              delta: {},
              finish_reason: sawToolCalls ? "tool_calls" : "stop",
              index: 0
            }
          ]
        })
      );
      sawFinishReason = true;
    }
    if (finalUsage !== undefined) {
      emit(controller, {
        ...(finalUsageTemplate ?? envelope({})),
        choices: [],
        usage: finalUsage
      });
      finalUsage = undefined;
    }
    if (sawDone) controller.enqueue("[DONE]");
  };

  return new TransformStream<string, string>({
    flush(controller) {
      emitTail(controller);
    },
    transform(data, controller) {
      if (data === "") return;
      if (data === "[DONE]") {
        // Everything after the tail is emitted at flush, once.
        sawDone = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        // A malformed event is dropped rather than failing the stream.
        return;
      }
      if (!isRecord(parsed)) return;
      const chunk = stripEchoSuffix(stripNoise(parsed), modelId);

      if (typeof chunk.id === "string") id ??= chunk.id;
      if (typeof chunk.model === "string") model ??= chunk.model;
      if (typeof chunk.created === "number") created ??= chunk.created;

      // An error payload passes through untouched for the consumer to surface;
      // it also ends the generation, so no finish reason is synthesized after it.
      if (isRecord(chunk.error)) {
        sawFinishReason = true;
        controller.enqueue(JSON.stringify(chunk));
        return;
      }

      if (Array.isArray(chunk.choices)) {
        if (chunk.choices.length === 0) {
          // Heartbeat, or OpenAI's own final usage chunk: hold the usage
          // until the end so exactly one usage chunk is emitted.
          if (isRecord(chunk.usage)) {
            finalUsage = chunk.usage;
            finalUsageTemplate = { ...chunk, usage: undefined };
            delete finalUsageTemplate.usage;
          }
          return;
        }
        const choices = chunk.choices.map((choice) => {
          if (!isRecord(choice)) return choice;
          if (typeof choice.finish_reason === "string") sawFinishReason = true;
          const delta = isRecord(choice.delta)
            ? normalizeDelta(choice.delta, relabelReasoning)
            : choice.delta;
          if (isRecord(delta)) {
            if (typeof delta.content === "string" && delta.content !== "")
              sawContent = true;
            if (typeof delta.reasoning_content === "string") sawContent = true;
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
              sawToolCalls = true;
          }
          if (!perDeltaUsage) return { ...choice, delta };
          const { usage: _perDeltaUsage, ...rest } = choice;
          return { ...rest, delta };
        });
        if (perDeltaUsage) {
          // The cumulative figure comes with the native tail.
          const { usage: _usage, ...rest } = chunk;
          emit(controller, { ...rest, choices });
        } else {
          emit(controller, { ...chunk, choices });
        }
        return;
      }

      // Native Workers AI events.
      if ("response" in chunk || "tool_calls" in chunk) {
        const text = chunk.response;
        const hasText = typeof text === "string" && text !== "";
        const calls = Array.isArray(chunk.tool_calls)
          ? chunk.tool_calls
              .map((call, index) => normalizeToolCall(call, index))
              .filter((call): call is Record_ => call !== undefined)
          : [];
        if (hasText || calls.length > 0) {
          if (hasText) sawContent = true;
          if (calls.length > 0) sawToolCalls = true;
          emit(
            controller,
            envelope({
              choices: [
                {
                  delta: {
                    ...(hasText ? { content: text } : {}),
                    ...(calls.length > 0 ? { tool_calls: calls } : {})
                  },
                  finish_reason: null,
                  index: 0
                }
              ]
            })
          );
        }
        if (isRecord(chunk.usage)) {
          // The native tail: cumulative usage for the whole stream.
          finalUsage = chunk.usage;
          finalUsageTemplate = undefined;
        }
        if (typeof chunk.finish_reason === "string") {
          sawFinishReason = true;
          emit(
            controller,
            envelope({
              choices: [
                { delta: {}, finish_reason: chunk.finish_reason, index: 0 }
              ]
            })
          );
        }
      }
    }
  });
}
