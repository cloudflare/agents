import type { Provider } from ".";

export function makeWorkersAI(_ai: unknown): Provider {
  /* @cloudflare/ai or fetch */
  return {
    invoke: async (_req, _opts) => {
      return { message: { role: "assistant", content: "Hello, world!" } };
    },
    stream: async (_req, _onDelta) => {
      return { message: { role: "assistant", content: "Hello, world!" } };
    }
  };
}
