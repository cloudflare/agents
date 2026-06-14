import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";

type Env = Cloudflare.Env & {
  AI: Ai;
};

/**
 * A minimal Think agent.
 *
 * Think gives you a streaming chat protocol, persistent message history,
 * resumable streams, and built-in workspace file tools out of the box.
 * Override `getModel` and `getSystemPrompt` to make it your own.
 */
export class Assistant extends Think<Env> {
  override getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.7-code",
      {
        sessionAffinity: this.sessionAffinity
      }
    );
  }

  override getSystemPrompt() {
    return "You are a helpful assistant. Keep answers clear, practical, and concise.";
  }
}
