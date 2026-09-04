/**
 * Workers AI ↔ OpenAI chat-completions compat, shared by every framework
 * provider in `agents/models/*`. Frameworks speak strict OpenAI chat
 * completions; this layer absorbs what the Cloudflare run path and each model
 * family do differently.
 *
 * @experimental This surface is experimental and may change.
 */

export {
  type ChatCompletionsQuirks,
  type CompatWarning,
  isWorkersAI,
  quirksFor
} from "./quirks";
export { type PreparedRequest, prepareChatCompletionsRequest } from "./request";
export { normalizeChatCompletion, normalizeToolCall } from "./response";
export {
  normalizeChatCompletionsStream,
  type StreamNormalizationOptions
} from "./stream";
