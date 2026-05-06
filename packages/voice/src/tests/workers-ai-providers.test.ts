import { describe, expect, it } from "vitest";
import { WorkersAIFluxSTT, WorkersAINova3STT } from "../workers-ai-providers";

class MockWebSocket {
  accepted = false;
  closed = false;
  sent: ArrayBuffer[] = [];
  #listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  accept(): void {
    this.accepted = true;
  }

  close(): void {
    this.closed = true;
    this.dispatch("close", {});
  }

  send(chunk: ArrayBuffer): void {
    this.sent.push(chunk);
  }

  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void
  ) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  dispatch(type: string, event: { data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }

  message(data: unknown): void {
    this.dispatch("message", { data });
  }
}

class MockAi {
  sockets: MockWebSocket[] = [];
  calls: Array<{
    model: string;
    input: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];

  async run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown> {
    this.calls.push({ model, input, options });
    const webSocket = new MockWebSocket();
    this.sockets.push(webSocket);
    return { webSocket: webSocket as unknown as WebSocket };
  }
}

async function waitForConnect(ai: MockAi): Promise<MockWebSocket> {
  await Promise.resolve();
  await Promise.resolve();
  const socket = ai.sockets.at(-1);
  if (!socket) throw new Error("expected a mock websocket to be created");
  return socket;
}

describe("WorkersAIFluxSTT", () => {
  it("uses the latest interim transcript when EndOfTurn transcript is empty", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];
    const interims: string[] = [];

    new WorkersAIFluxSTT(ai).createSession({
      onInterim: (text) => interims.push(text),
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(JSON.stringify({ event: "StartOfTurn" }));
    socket.message(JSON.stringify({ event: "Update", transcript: "hello" }));
    socket.message(
      JSON.stringify({ event: "EagerEndOfTurn", transcript: "hello world" })
    );
    socket.message(JSON.stringify({ event: "EndOfTurn", transcript: "" }));

    expect(interims).toEqual(["hello", "hello world"]);
    expect(utterances).toEqual(["hello world"]);
  });

  it("prefers non-empty EndOfTurn transcript and clears turn state", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];

    new WorkersAIFluxSTT(ai).createSession({
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(JSON.stringify({ event: "Update", transcript: "stale" }));
    socket.message(
      JSON.stringify({ event: "EndOfTurn", transcript: "final text" })
    );
    socket.message(JSON.stringify({ event: "EndOfTurn", transcript: "" }));

    expect(utterances).toEqual(["final text"]);
  });

  it("does not emit a stale eager transcript after TurnResumed", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];

    new WorkersAIFluxSTT(ai).createSession({
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(
      JSON.stringify({ event: "EagerEndOfTurn", transcript: "not done" })
    );
    socket.message(JSON.stringify({ event: "TurnResumed" }));
    socket.message(JSON.stringify({ event: "EndOfTurn", transcript: "" }));

    expect(utterances).toEqual([]);
  });

  it("preserves the default Flux input when no multilingual options are provided", async () => {
    const ai = new MockAi();

    new WorkersAIFluxSTT(ai).createSession();
    await waitForConnect(ai);

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].model).toBe("@cf/deepgram/flux");
    expect(ai.calls[0].input).toEqual({
      encoding: "linear16",
      sample_rate: "16000"
    });
    expect(ai.calls[0].options).toEqual({ websocket: true });
  });

  it("uses Flux Multilingual automatically when language hints are provided", async () => {
    const ai = new MockAi();

    new WorkersAIFluxSTT(ai, {
      languageHints: ["en", "es"]
    }).createSession();
    await waitForConnect(ai);

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].input).toMatchObject({
      model: "flux-general-multi",
      language_hint: ["en", "es"]
    });
  });

  it("passes explicit Flux model selection for multilingual auto-detection", async () => {
    const ai = new MockAi();

    new WorkersAIFluxSTT(ai, {
      model: "flux-general-multi"
    }).createSession();
    await waitForConnect(ai);

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].input).toMatchObject({
      model: "flux-general-multi"
    });
    expect(ai.calls[0].input).not.toHaveProperty("language_hint");
  });
});

describe("WorkersAINova3STT", () => {
  it("combines finalized segments and interim text without changing normal behavior", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];
    const interims: string[] = [];

    new WorkersAINova3STT(ai).createSession({
      onInterim: (text) => interims.push(text),
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: false,
        channel: { alternatives: [{ transcript: "hello" }] }
      })
    );
    socket.message(
      JSON.stringify({
        type: "Results",
        is_final: false,
        speech_final: false,
        channel: { alternatives: [{ transcript: "world" }] }
      })
    );
    socket.message(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: true,
        channel: { alternatives: [{ transcript: "world" }] }
      })
    );

    expect(interims).toEqual(["hello world"]);
    expect(utterances).toEqual(["hello world"]);
  });

  it("ignores malformed messages and empty speech_final results", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];

    new WorkersAINova3STT(ai).createSession({
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message("not json");
    socket.message(
      JSON.stringify({
        type: "Results",
        is_final: false,
        speech_final: true,
        channel: { alternatives: [{ transcript: "" }] }
      })
    );

    expect(utterances).toEqual([]);
  });
});
