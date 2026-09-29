import { afterEach, expect, it, vi } from "vitest";
import { DeepgramSTT } from "../src/index";

class MockWebSocket extends EventTarget {
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn(() => this.dispatchEvent(new Event("close")));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("rejects readiness and reports a fatal error when the socket upgrade fails", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ webSocket: undefined }) as unknown as Response)
  );
  const fatalErrors: unknown[] = [];

  try {
    const session = new DeepgramSTT({ apiKey: "test-key" }).createSession({
      onFatalError: (error) => fatalErrors.push(error)
    });
    if (!session.waitUntilReady) throw new Error("expected readiness method");

    await expect(session.waitUntilReady()).rejects.toThrow(
      "Deepgram did not return a WebSocket"
    );
    expect(fatalErrors).toHaveLength(1);
    expect((fatalErrors[0] as Error).message).toBe(
      "Deepgram did not return a WebSocket"
    );
  } finally {
    errorLog.mockRestore();
  }
});

it("reports one runtime fatal error and ignores intentional close", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const ws = new MockWebSocket();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ webSocket: ws }) as unknown as Response)
  );
  const fatalErrors: unknown[] = [];

  try {
    const session = new DeepgramSTT({ apiKey: "test-key" }).createSession({
      onFatalError: (error) => fatalErrors.push(error)
    });
    await session.waitUntilReady?.();

    ws.dispatchEvent(new Event("error"));
    ws.dispatchEvent(new Event("close"));
    session.close();

    expect(fatalErrors).toHaveLength(1);
    expect((fatalErrors[0] as Error).message).toBe("Deepgram WebSocket error");
  } finally {
    errorLog.mockRestore();
  }
});
