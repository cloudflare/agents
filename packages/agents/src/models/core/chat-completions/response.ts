/**
 * Normalizes a chat-completions response body from the run path into the
 * strict OpenAI `chat.completion` shape, so framework parsers never see
 * Workers AI's native envelope or its field spellings.
 */

import { quirksFor } from "./quirks";

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Native `{ name, arguments: object }` → OpenAI `{ id, type, function }`. */
export function normalizeToolCall(
  entry: unknown,
  index: number
): Record_ | undefined {
  if (!isRecord(entry)) return undefined;
  const fn = isRecord(entry.function) ? entry.function : undefined;
  const name =
    typeof fn?.name === "string"
      ? fn.name
      : typeof entry.name === "string"
        ? entry.name
        : undefined;
  if (name === undefined) return undefined;
  const rawArguments =
    fn !== undefined && "arguments" in fn ? fn.arguments : entry.arguments;
  const args =
    typeof rawArguments === "string"
      ? rawArguments
      : rawArguments === undefined || rawArguments === null
        ? "{}"
        : JSON.stringify(rawArguments);
  return {
    ...(typeof entry.index === "number" ? { index: entry.index } : { index }),
    ...(typeof entry.id === "string" ? { id: entry.id } : {}),
    function: { arguments: args, name },
    type: "function",
    ...(entry.extra_content !== undefined
      ? { extra_content: entry.extra_content }
      : {})
  };
}

/** Text as the model produced it; structured-output models may return an object. */
function contentText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function stripEchoSuffix(model: unknown, modelId: string): unknown {
  const suffix = quirksFor(modelId).modelEchoSuffix;
  if (typeof model !== "string" || suffix === undefined) return model;
  return model.endsWith(suffix) ? model.slice(0, -suffix.length) : model;
}

/** Puts reasoning under `reasoning_content` whichever spelling the model used. */
function normalizeMessage(message: Record_): Record_ {
  const out: Record_ = { ...message };
  const reasoning =
    typeof out.reasoning_content === "string" && out.reasoning_content !== ""
      ? out.reasoning_content
      : typeof out.reasoning === "string" && out.reasoning !== ""
        ? out.reasoning
        : undefined;
  delete out.reasoning;
  if (reasoning !== undefined) out.reasoning_content = reasoning;
  else delete out.reasoning_content;
  if ("content" in out) out.content = contentText(out.content);
  if (Array.isArray(out.tool_calls)) {
    const calls = out.tool_calls
      .map((call, index) => normalizeToolCall(call, index))
      .filter((call): call is Record_ => call !== undefined);
    if (calls.length > 0) out.tool_calls = calls;
    else delete out.tool_calls;
  }
  return out;
}

/**
 * Returns the body in the strict `chat.completion` shape. Already-OpenAI
 * bodies come back with their reasoning spelling unified and the echoed model
 * id cleaned; native Workers AI `{ response, tool_calls, usage }` bodies are
 * lifted into `choices[0]`.
 */
export function normalizeChatCompletion(
  body: unknown,
  modelId: string
): Record_ {
  if (!isRecord(body)) return { choices: [] };
  if (Array.isArray(body.choices)) {
    const choices = body.choices.map((choice) => {
      if (!isRecord(choice)) return choice;
      const message = isRecord(choice.message)
        ? normalizeMessage(choice.message)
        : choice.message;
      const hasToolCalls =
        isRecord(message) &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length > 0;
      return {
        ...choice,
        message,
        finish_reason:
          choice.finish_reason ?? (hasToolCalls ? "tool_calls" : "stop")
      };
    });
    return { ...body, choices, model: stripEchoSuffix(body.model, modelId) };
  }
  if ("response" in body || "tool_calls" in body) {
    const toolCalls = Array.isArray(body.tool_calls)
      ? body.tool_calls
          .map((call, index) => normalizeToolCall(call, index))
          .filter((call): call is Record_ => call !== undefined)
      : [];
    const { response, tool_calls: _toolCalls, usage, ...rest } = body;
    return {
      ...rest,
      choices: [
        {
          finish_reason:
            typeof body.finish_reason === "string"
              ? body.finish_reason
              : toolCalls.length > 0
                ? "tool_calls"
                : "stop",
          index: 0,
          message: {
            content: contentText(response),
            role: "assistant",
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
          }
        }
      ],
      model: stripEchoSuffix(body.model, modelId),
      ...(usage !== undefined ? { usage } : {})
    };
  }
  return body;
}
