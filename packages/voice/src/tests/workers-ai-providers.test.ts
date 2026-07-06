import { describe, expect, it, vi } from "vitest";
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
  mode: "socket" | "throw" | "no_socket" = "socket";
  deferRun = false;
  sockets: MockWebSocket[] = [];
  calls: Array<{
    model: string;
    input: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  #resolveRun: (() => void) | null = null;

  resolveRun(): void {
    const resolve = this.#resolveRun;
    if (!resolve) return;
    this.#resolveRun = null;
    resolve();
  }

  async run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown> {
    this.calls.push({ model, input, options });
    if (this.deferRun) {
      await new Promise<void>((resolve) => {
        this.#resolveRun = resolve;
      });
    }
    if (this.mode === "throw") throw new Error("run failed");
    if (this.mode === "no_socket") return {};
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
  it("resolves readiness after the WebSocket is accepted and pending audio is flushed", async () => {
    const ai = new MockAi();
    const session = new WorkersAIFluxSTT(ai).createSession();
    const chunk = new ArrayBuffer(4);

    session.feed(chunk);
    if (!session.waitUntilReady) throw new Error("expected readiness method");
    await session.waitUntilReady();

    const socket = ai.sockets[0];
    expect(socket.accepted).toBe(true);
    expect(socket.sent).toEqual([chunk]);
  });

  it("rejects readiness when ai.run throws", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const ai = new MockAi();
    ai.mode = "throw";
    try {
      const session = new WorkersAIFluxSTT(ai).createSession();
      if (!session.waitUntilReady) throw new Error("expected readiness method");

      await expect(session.waitUntilReady()).rejects.toThrow("run failed");
    } finally {
      errorLog.mockRestore();
    }
  });

  it("rejects readiness when ai.run returns no WebSocket", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const ai = new MockAi();
    ai.mode = "no_socket";
    try {
      const session = new WorkersAIFluxSTT(ai).createSession();
      if (!session.waitUntilReady) throw new Error("expected readiness method");

      await expect(session.waitUntilReady()).rejects.toThrow(
        "Workers AI Flux STT did not return a WebSocket"
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("settles readiness when closed before the WebSocket connects", async () => {
    const ai = new MockAi();
    ai.deferRun = true;
    const session = new WorkersAIFluxSTT(ai).createSession();
    if (!session.waitUntilReady) throw new Error("expected readiness method");

    const ready = session.waitUntilReady();
    await Promise.resolve();
    session.close();

    await expect(ready).resolves.toBeUndefined();
    ai.resolveRun();

    const socket = await waitForConnect(ai);
    expect(socket.accepted).toBe(true);
    expect(socket.closed).toBe(true);
  });

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

  it("uses StartOfTurn transcript when EndOfTurn transcript is empty", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];
    const interims: string[] = [];
    const speechStarts: Array<string | undefined> = [];

    new WorkersAIFluxSTT(ai).createSession({
      onInterim: (text) => interims.push(text),
      onSpeechStart: (text) => speechStarts.push(text),
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(
      JSON.stringify({ event: "StartOfTurn", transcript: "hello" })
    );
    socket.message(JSON.stringify({ event: "EndOfTurn", transcript: "" }));

    expect(interims).toEqual(["hello"]);
    expect(speechStarts).toEqual(["hello"]);
    expect(utterances).toEqual(["hello"]);
  });

  it("emits speech start without requiring a transcript", async () => {
    const ai = new MockAi();
    const speechStarts: Array<string | undefined> = [];

    new WorkersAIFluxSTT(ai).createSession({
      onSpeechStart: (text) => speechStarts.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(JSON.stringify({ event: "StartOfTurn" }));

    expect(speechStarts).toEqual([undefined]);
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

  it("uses resumed transcript instead of stale eager transcript", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];
    const interims: string[] = [];

    new WorkersAIFluxSTT(ai).createSession({
      onInterim: (text) => interims.push(text),
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(
      JSON.stringify({ event: "EagerEndOfTurn", transcript: "not done" })
    );
    socket.message(
      JSON.stringify({ event: "TurnResumed", transcript: "not done yet" })
    );
    socket.message(JSON.stringify({ event: "EndOfTurn", transcript: "" }));

    expect(interims).toEqual(["not done", "not done yet"]);
    expect(utterances).toEqual(["not done yet"]);
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

  it("handles late Results messages after websocket close", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];

    new WorkersAINova3STT(ai).createSession({
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: false,
        channel: { alternatives: [{ transcript: "late" }] }
      })
    );
    socket.close();
    socket.message(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: true,
        channel: { alternatives: [{ transcript: "message" }] }
      })
    );

    expect(utterances).toEqual(["late message"]);
  });
});
