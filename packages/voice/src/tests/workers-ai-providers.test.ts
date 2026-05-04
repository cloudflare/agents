import { describe, expect, it } from "vitest";
import { WorkersAIFluxSTT } from "../workers-ai-providers";

function createMockAi() {
  const calls: Array<{
    model: string;
    input: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];

  return {
    calls,
    ai: {
      async run(
        model: string,
        input: Record<string, unknown>,
        options?: Record<string, unknown>
      ) {
        calls.push({ model, input, options });
        const pair = new WebSocketPair();
        return { webSocket: pair[0] };
      }
    }
  };
}

async function waitForRun(calls: unknown[]) {
  for (let i = 0; i < 10; i++) {
    if (calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("WorkersAIFluxSTT", () => {
  it("preserves the default Flux input when no multilingual options are provided", async () => {
    const { ai, calls } = createMockAi();

    const transcriber = new WorkersAIFluxSTT(ai);
    const session = transcriber.createSession();
    await waitForRun(calls);
    session.close();

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("@cf/deepgram/flux");
    expect(calls[0].input).toEqual({
      encoding: "linear16",
      sample_rate: "16000"
    });
    expect(calls[0].options).toEqual({ websocket: true });
  });

  it("uses Flux Multilingual automatically when language hints are provided", async () => {
    const { ai, calls } = createMockAi();

    const transcriber = new WorkersAIFluxSTT(ai, {
      languageHints: ["en", "es"]
    });
    const session = transcriber.createSession();
    await waitForRun(calls);
    session.close();

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toMatchObject({
      model: "flux-general-multi",
      language_hint: ["en", "es"]
    });
  });

  it("passes explicit Flux model selection for multilingual auto-detection", async () => {
    const { ai, calls } = createMockAi();

    const transcriber = new WorkersAIFluxSTT(ai, {
      model: "flux-general-multi"
    });
    const session = transcriber.createSession();
    await waitForRun(calls);
    session.close();

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toMatchObject({
      model: "flux-general-multi"
    });
    expect(calls[0].input).not.toHaveProperty("language_hint");
  });
});
