/**
 * Rewrites a strict OpenAI chat-completions request body into what a given
 * catalog model accepts. Frameworks build the strict body from their own
 * prompt types; everything Cloudflare- or vendor-specific happens here, once.
 *
 * The rewrite never throws: a feature the model cannot take is dropped and
 * reported as a {@link CompatWarning}.
 */

import { type CompatWarning, quirksFor } from "./quirks";

export interface PreparedRequest {
  body: Record<string, unknown>;
  warnings: CompatWarning[];
  /**
   * Whether the body turns the model's reasoning off through the chat
   * template. The stream normalizer needs this for models whose streaming
   * parser mislabels the answer once thinking is off.
   */
  reasoningOff: boolean;
}

type Message = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampEffort(effort: string): string {
  if (effort === "minimal") return "low";
  if (effort === "xhigh") return "high";
  return effort;
}

/** Drops URL image parts (keeps inline data URLs) from a user message. */
function stripImageUrls(message: Message, warnings: CompatWarning[]): Message {
  if (!Array.isArray(message.content)) return message;
  let dropped = 0;
  const content = message.content.filter((part) => {
    if (!isRecord(part) || part.type !== "image_url") return true;
    const image = isRecord(part.image_url) ? part.image_url : undefined;
    const url = typeof image?.url === "string" ? image.url : "";
    if (url.startsWith("data:")) return true;
    dropped += 1;
    return false;
  });
  if (dropped > 0) {
    warnings.push({
      feature: "image-url",
      message: `Workers AI models need image bytes; ${dropped} image URL${dropped === 1 ? " was" : "s were"} dropped.`
    });
  }
  return { ...message, content };
}

/** Nine `[A-Za-z0-9]` characters: what Mistral accepts as a tool-call id. */
const CONFORMANT_TOOL_CALL_ID = /^[0-9A-Za-z]{9}$/;

const TOOL_CALL_ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A deterministic nine-character id for an original id: the same conversation
 * replayed twice produces the same ids, so a provider cache or a log stays
 * comparable. `salt` is bumped only to break a collision.
 */
function hashedToolCallId(original: string, salt: number): string {
  let state = (0x811c9dc5 ^ salt) >>> 0;
  for (let index = 0; index < original.length; index += 1) {
    state = Math.imul(state ^ original.charCodeAt(index), 0x01000193) >>> 0;
  }
  let id = "";
  for (let index = 0; index < 9; index += 1) {
    state = Math.imul(state ^ (state >>> 15), 0x01000193) >>> 0;
    id += TOOL_CALL_ID_ALPHABET[state % TOOL_CALL_ID_ALPHABET.length];
  }
  return id;
}

/** Every tool-call id a message set mentions, in the order it mentions them. */
function toolCallIdsIn(messages: unknown[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || seen.has(value)) return;
    seen.add(value);
    ids.push(value);
  };
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (isRecord(call)) add(call.id);
      }
    }
    add(message.tool_call_id);
  }
  return ids;
}

/**
 * Plans the rewrite: which ids have to change, and to what. Ids that already
 * conform are kept exactly as they are — including as reserved values, so a
 * rewritten id can never collide with one.
 */
function planToolCallIds(messages: unknown[]): Map<string, string> {
  const plan = new Map<string, string>();
  const ids = toolCallIdsIn(messages);
  const taken = new Set(ids.filter((id) => CONFORMANT_TOOL_CALL_ID.test(id)));
  for (const id of ids) {
    if (taken.has(id)) continue;
    let replacement = hashedToolCallId(id, 0);
    for (let salt = 1; taken.has(replacement) && salt <= 64; salt += 1) {
      replacement = hashedToolCallId(id, salt);
    }
    taken.add(replacement);
    plan.set(id, replacement);
  }
  return plan;
}

/** Applies the plan to an assistant `tool_calls` turn or a `tool` result. */
function rewriteToolCallIds(
  message: Message,
  plan: Map<string, string>
): Message {
  let rewritten = message;
  if (Array.isArray(rewritten.tool_calls)) {
    rewritten = {
      ...rewritten,
      tool_calls: rewritten.tool_calls.map((call) => {
        if (!isRecord(call) || typeof call.id !== "string") return call;
        const replacement = plan.get(call.id);
        return replacement === undefined ? call : { ...call, id: replacement };
      })
    };
  }
  if (typeof rewritten.tool_call_id === "string") {
    const replacement = plan.get(rewritten.tool_call_id);
    if (replacement !== undefined) {
      rewritten = { ...rewritten, tool_call_id: replacement };
    }
  }
  return rewritten;
}

/**
 * Applies the model's quirks to a strict OpenAI chat-completions body.
 *
 * Conventions the strict body follows, which this function translates:
 * - `max_tokens` is the cap; it becomes `max_completion_tokens` where needed.
 * - `reasoning_effort: null` means "turn reasoning off".
 * - Replayed assistant reasoning sits in `reasoning_content`.
 * - `response_format.json_schema` is the OpenAI `{ name, schema }` envelope.
 * - `chat_template_kwargs` may be present; it is only meaningful on Workers AI.
 */
export function prepareChatCompletionsRequest(
  input: Record<string, unknown>,
  modelId: string
): PreparedRequest {
  const quirks = quirksFor(modelId);
  const warnings: CompatWarning[] = [];
  const body: Record<string, unknown> = { ...input };

  // Output-token cap.
  if (
    quirks.maxTokensField === "max_completion_tokens" &&
    "max_tokens" in body
  ) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }

  // Reasoning.
  if ("reasoning_effort" in body) {
    const effort = body.reasoning_effort;
    if (effort === null) {
      delete body.reasoning_effort;
      if (quirks.reasoningOff === "chat-template") {
        body.chat_template_kwargs = {
          ...(isRecord(body.chat_template_kwargs)
            ? body.chat_template_kwargs
            : {}),
          enable_thinking: false
        };
      } else {
        warnings.push({
          feature: "reasoning-off",
          message: `Reasoning cannot be turned off on ${modelId}; the request was sent with the model's default effort.`
        });
      }
    } else if (
      typeof effort === "string" &&
      quirks.reasoningEffortLevels === "basic"
    ) {
      body.reasoning_effort = clampEffort(effort);
    }
  }
  if (
    "chat_template_kwargs" in body &&
    quirks.chatTemplateKwargs === "unsupported"
  ) {
    delete body.chat_template_kwargs;
    warnings.push({
      feature: "chat-template-kwargs",
      message: `${modelId} does not take chat_template_kwargs; they were dropped.`
    });
  }

  // Structured output.
  if (isRecord(body.response_format)) {
    if (quirks.jsonSchema === "unsupported") {
      delete body.response_format;
      warnings.push({
        feature: "response-format",
        message: `${modelId} does not support response_format; the request was sent without it.`
      });
    } else if (
      body.response_format.type === "json_schema" &&
      isRecord(body.response_format.json_schema)
    ) {
      const { strict: _strict, ...envelope } = body.response_format.json_schema;
      body.response_format = {
        ...body.response_format,
        json_schema: quirks.jsonSchemaStrict
          ? { ...envelope, strict: true }
          : envelope
      };
    }
  }

  // Tools.
  if (
    body.tool_choice === "required" &&
    quirks.toolChoiceRequired === "named-fallback"
  ) {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const only =
      tools.length === 1 && isRecord(tools[0]) ? tools[0] : undefined;
    const name =
      only !== undefined &&
      isRecord(only.function) &&
      typeof only.function.name === "string"
        ? only.function.name
        : undefined;
    if (name !== undefined) {
      body.tool_choice = { function: { name }, type: "function" };
    } else {
      delete body.tool_choice;
      warnings.push({
        feature: "tool-choice-required",
        message: `${modelId} rejects tool_choice "required"; the model was left free to choose.`
      });
    }
  }

  // Messages.
  if (Array.isArray(body.messages)) {
    // Two passes: the ids are planned over the whole conversation first, so an
    // assistant turn and the tool result answering it are rewritten to the
    // same value however far apart they sit.
    const toolCallIds =
      quirks.toolCallIds === "alnum-9"
        ? planToolCallIds(body.messages)
        : new Map<string, string>();
    if (toolCallIds.size > 0) {
      warnings.push({
        feature: "tool-call-id",
        message: `${modelId} needs 9-character alphanumeric tool-call ids; ${toolCallIds.size} id${toolCallIds.size === 1 ? " was" : "s were"} rewritten.`
      });
    }
    const messages: Message[] = [];
    let previousRole: unknown;
    for (const entry of body.messages) {
      if (!isRecord(entry)) continue;
      let message: Message = entry;
      if (toolCallIds.size > 0) {
        message = rewriteToolCallIds(message, toolCallIds);
      }
      if (message.role === "user" && quirks.imageUrls === "data-only") {
        message = stripImageUrls(message, warnings);
      }
      if (
        message.role === "assistant" &&
        message.content === null &&
        quirks.nullAssistantContent === "empty-string"
      ) {
        // 41-demos-gpt-oss-120b-O_replay_null: a replayed assistant turn with
        // `content: null` is a 400 on Workers AI; `""` is accepted everywhere.
        message = { ...message, content: "" };
      }
      if (message.role === "assistant" && "reasoning_content" in message) {
        if (quirks.reasoningReplay === "drop") {
          const { reasoning_content: _reasoning, ...rest } = message;
          message = rest;
          warnings.push({
            feature: "assistant-reasoning",
            message: `${modelId} has no field for replayed reasoning; the assistant reasoning was dropped.`
          });
        }
      }
      if (
        quirks.requiresAssistantAfterToolResult &&
        previousRole === "tool" &&
        message.role === "user"
      ) {
        messages.push({ content: "", role: "assistant" });
      }
      messages.push(message);
      previousRole = message.role;
    }
    body.messages = messages;
  }

  const reasoningOff =
    isRecord(body.chat_template_kwargs) &&
    body.chat_template_kwargs.enable_thinking === false;
  return { body, reasoningOff, warnings };
}
