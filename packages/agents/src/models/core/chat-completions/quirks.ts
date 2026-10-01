/**
 * Where a Cloudflare catalog model departs from strict OpenAI chat
 * completions, and how. Every entry is backed by a live capture from the
 * conformance probes (`research/40-*.json`, `41-*.json`); the default for an
 * unknown id is strict OpenAI, so a new conformant model needs no code here.
 *
 * Framework-neutral: both the AI SDK and the pi-ai providers consult this.
 */

/** A request feature that had to be changed or dropped for a model. */
export interface CompatWarning {
  feature: string;
  message: string;
}

export interface ChatCompletionsQuirks {
  /** Which field carries the output-token cap. OpenAI's current models reject `max_tokens`. */
  maxTokensField: "max_tokens" | "max_completion_tokens";
  /**
   * How reasoning can be turned off. `chat-template` sends
   * `chat_template_kwargs.enable_thinking = false` (vLLM); `unsupported` drops
   * the request with a warning because the model keeps reasoning regardless.
   */
  reasoningOff: "chat-template" | "unsupported";
  /**
   * Which `reasoning_effort` levels the model accepts. `openai` is the full
   * set (`minimal` … `xhigh`); `basic` is `low | medium | high`, everything
   * else clamped.
   */
  reasoningEffortLevels: "openai" | "basic";
  /** Whether `chat_template_kwargs` is accepted at all. */
  chatTemplateKwargs: "supported" | "unsupported";
  /** Whether `response_format: json_schema` is accepted at all. */
  jsonSchema: "supported" | "unsupported";
  /** Whether the OpenAI-only `strict` flag belongs on the json_schema envelope. */
  jsonSchemaStrict: boolean;
  /**
   * `tool_choice: "required"`. `named-fallback` rewrites it to the single
   * named tool when there is exactly one (glm-4.7-flash answers 400 to
   * `required`, a gateway serialization bug), and drops it otherwise.
   */
  toolChoiceRequired: "supported" | "named-fallback";
  /** Whether image parts may reference a URL, or must carry inline bytes. */
  imageUrls: "any" | "data-only";
  /** Whether replayed assistant reasoning (`reasoning_content`) is accepted. */
  reasoningReplay: "reasoning_content" | "drop";
  /**
   * Whether a `user` turn may directly follow a `tool` turn. Mistral rejects
   * it ("Unexpected role 'user' after role 'tool'"), so an empty assistant
   * turn is inserted between them.
   */
  requiresAssistantAfterToolResult: boolean;
  /**
   * What the model accepts as a tool-call id. `alnum-9` is Mistral's rule:
   * exactly nine `[A-Za-z0-9]` characters, anything else is a 400.
   */
  toolCallIds: "any" | "alnum-9";
  /** A suffix the model echoes on its own id that callers never asked for. */
  modelEchoSuffix: string | undefined;
  /** Whether a replayed assistant turn may carry `content: null`. */
  nullAssistantContent: "allowed" | "empty-string";
  /**
   * Where the answer lands in a stream once reasoning has been turned off.
   * `reasoning` means the model's streaming parser mislabels the whole answer
   * as reasoning (its non-streaming body is fine), so the normalizer moves
   * those deltas back into `content`.
   */
  reasoningOffStreamLabel: "content" | "reasoning";
}

const STRICT_OPENAI: ChatCompletionsQuirks = {
  chatTemplateKwargs: "unsupported",
  imageUrls: "any",
  jsonSchema: "supported",
  jsonSchemaStrict: false,
  maxTokensField: "max_tokens",
  modelEchoSuffix: undefined,
  nullAssistantContent: "allowed",
  reasoningEffortLevels: "basic",
  reasoningOff: "unsupported",
  reasoningOffStreamLabel: "content",
  reasoningReplay: "drop",
  requiresAssistantAfterToolResult: false,
  toolCallIds: "any",
  toolChoiceRequired: "supported"
};

/** Workers AI's vLLM front end: what every `@cf/` model has in common. */
const WORKERS_AI: ChatCompletionsQuirks = {
  ...STRICT_OPENAI,
  chatTemplateKwargs: "supported",
  imageUrls: "data-only",
  nullAssistantContent: "empty-string",
  reasoningOff: "chat-template",
  reasoningReplay: "reasoning_content"
};

/**
 * Longest-prefix overrides. Keep each one evidence-backed (the capture that
 * proves it is named in the comment) and delete it when the platform fixes
 * the deviation.
 */
const OVERRIDES: [prefix: string, quirks: Partial<ChatCompletionsQuirks>][] = [
  // 40-demos-...-E1: `tool_choice: "required"` + tools → 400 pydantic parse error.
  ["@cf/zai-org/glm-4.7-flash", { toolChoiceRequired: "named-fallback" }],
  // 40-demos-kimi-k3-G3 / 40-matt-kimi-k2.7-code-G_ctk: enable_thinking=false
  // leaves reasoning on; nothing turns it off.
  ["@cf/moonshotai/", { reasoningOff: "unsupported" }],
  // 40-demos-gpt-oss-120b-G3: same.
  ["@cf/openai/", { reasoningOff: "unsupported" }],
  // 40-demos-...-F1/F2/G3/J1: "chat_template is not supported for Mistral
  // tokenizers", "Unexpected role 'user' after role 'tool'".
  // 40-matt-mistral-small-3.1-24b-instruct-J: "Tool call id was call_1 but
  // must be a-z, A-Z, 0-9, with a length of 9."
  [
    "@cf/mistralai/",
    {
      chatTemplateKwargs: "unsupported",
      jsonSchema: "unsupported",
      reasoningOff: "unsupported",
      requiresAssistantAfterToolResult: true,
      toolCallIds: "alnum-9"
    }
  ],
  // 40-demos-gemma-4-26b-a4b-it-A: echoes "@cf/google/gemma-4-26b-a4b-it-external".
  ["@cf/google/", { modelEchoSuffix: "-external" }],
  // 41-matt-nemotron-3-120b-a12b-K_emoji / S_usage_s: with enable_thinking=false
  // every streamed token arrives as `delta.reasoning` and `content` stays
  // empty, while the non-streaming body (A0, 40-...-G_ctk) puts the same
  // answer in `content` with `reasoning: null`.
  ["@cf/nvidia/nemotron-", { reasoningOffStreamLabel: "reasoning" }]
];

/** The quirks for a catalog id: base profile plus the longest matching override. */
export function quirksFor(modelId: string): ChatCompletionsQuirks {
  const base = modelId.startsWith("@cf/") ? WORKERS_AI : STRICT_OPENAI;
  let best: [string, Partial<ChatCompletionsQuirks>] | undefined;
  for (const entry of OVERRIDES) {
    if (
      modelId.startsWith(entry[0]) &&
      (best === undefined || entry[0].length > best[0].length)
    ) {
      best = entry;
    }
  }
  return best === undefined ? base : { ...base, ...best[1] };
}

/** Whether an id is a Workers AI model rather than a third-party catalog model. */
export function isWorkersAI(modelId: string): boolean {
  return modelId.startsWith("@cf/");
}
