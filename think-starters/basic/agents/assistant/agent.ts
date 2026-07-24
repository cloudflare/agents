import { Think } from "@cloudflare/think";

/**
 * A minimal Think agent.
 *
 * Think gives you a streaming chat protocol, persistent message history,
 * resumable streams, and built-in workspace file tools out of the box.
 * Override `getModel` and `getSystemPrompt` to make it your own.
 */
export class Assistant extends Think<Env> {
  override getModel() {
    // Resolved via the built-in workers-ai-provider off env.AI. Use a
    // "@cf/..." id for Workers AI, or a "provider/model" slug like
    // "openai/gpt-5.5" to route through AI Gateway.
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  override getSystemPrompt() {
    return "You are a helpful assistant. Keep answers clear, practical, and concise.";
  }
}
