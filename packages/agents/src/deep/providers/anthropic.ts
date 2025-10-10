import type { Provider } from ".";

export function makeAnthropic(_baseUrl: string, _apiKey: string): Provider {
  /* SSE parse */
  return {
    invoke: async (_req, _opts) => {
      return { message: { role: "assistant", content: "Hello, world!" } };
    },
    stream: async (_req, _onDelta) => {
      return { message: { role: "assistant", content: "Hello, world!" } };
    }
  };
}
