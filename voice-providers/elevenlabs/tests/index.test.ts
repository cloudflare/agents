import { afterEach, expect, it, vi } from "vitest";
import { ElevenLabsSTT } from "../src/index";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("rejects readiness when closed while the connection is pending", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {}))
  );

  const session = new ElevenLabsSTT({ apiKey: "test-key" }).createSession();
  const readiness = expect(session.waitUntilReady?.()).rejects.toThrow(
    "ElevenLabsSTT: WebSocket closed before session start."
  );

  session.close();

  await readiness;
});
