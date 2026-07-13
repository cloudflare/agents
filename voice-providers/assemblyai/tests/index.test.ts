import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssemblyAISTT,
  _buildConnectionUrl,
  type AssemblyAISTTOptions
} from "../src/index";

function parse(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

// --- WebSocket / fetch test infrastructure (shared by all session tests) ---

class MockWebSocket extends EventTarget {
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
}

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function setupMockFetch(): { ws: MockWebSocket; calls: MockFetchCall[] } {
  const ws = new MockWebSocket();
  const calls: MockFetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      // Cloudflare's fetch-upgrade returns a Response-shaped object with a
      // webSocket property. Cast to mirror the runtime.
      return { webSocket: ws } as unknown as Response;
    })
  );
  return { ws, calls };
}

// Flush microtasks so the session's async #connect() runs.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// A PCM chunk of `bytes` length filled with `fill`, for identity/content
// assertions. 3200 bytes = the pipeline's 100ms browser chunk; 640 bytes =
// a 20ms telephony frame (both at 16kHz mono s16le).
function pcm(bytes: number, fill = 0): ArrayBuffer {
  return new Uint8Array(bytes).fill(fill).buffer;
}

beforeEach(() => {
  // Default no-op fetch so any test that doesn't set up its own mock never
  // makes a real network call (the session constructor connects on its own).
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => ({ webSocket: new MockWebSocket() }) as unknown as Response
    )
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("_buildConnectionUrl — always-present params", () => {
  it("uses the AssemblyAI streaming host by default", () => {
    const url = new URL(_buildConnectionUrl({ apiKey: "k" }));
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("streaming.assemblyai.com");
    expect(url.pathname).toBe("/v3/ws");
  });

  it("hardcodes speech_model to universal-3-5-pro plus sample_rate, encoding", () => {
    const p = parse(_buildConnectionUrl({ apiKey: "k" }));
    expect(p.get("speech_model")).toBe("universal-3-5-pro");
    expect(p.get("sample_rate")).toBe("16000");
    expect(p.get("encoding")).toBe("pcm_s16le");
  });

  it("never sends format_turns or the API key in the query", () => {
    const p = parse(_buildConnectionUrl({ apiKey: "secret" }));
    expect(p.has("format_turns")).toBe(false);
    expect(p.has("token")).toBe(false);
    expect(p.has("apikey")).toBe(false);
    expect(p.has("ApiKey")).toBe(false);
  });
});

describe("_buildConnectionUrl — conditional params (only when set)", () => {
  it("omits all conditional params when none set", () => {
    const p = parse(_buildConnectionUrl({ apiKey: "k" }));
    for (const k of [
      "domain",
      "keyterms_prompt",
      "prompt",
      "min_turn_silence",
      "max_turn_silence",
      "interruption_delay",
      "vad_threshold",
      "continuous_partials",
      "language_detection",
      "mode",
      "agent_context",
      "previous_context_n_turns",
      "language_codes",
      "voice_focus",
      "voice_focus_threshold"
    ]) {
      expect(p.has(k)).toBe(false);
    }
  });

  it("forwards domain", () => {
    const p = parse(_buildConnectionUrl({ apiKey: "k", domain: "medical-v1" }));
    expect(p.get("domain")).toBe("medical-v1");
  });

  it("JSON-encodes keyterms into keyterms_prompt", () => {
    const p = parse(
      _buildConnectionUrl({
        apiKey: "k",
        keyterms: ["metoprolol", "Skyrizi"]
      })
    );
    expect(p.get("keyterms_prompt")).toBe('["metoprolol","Skyrizi"]');
  });

  it("forwards prompt", () => {
    const p = parse(
      _buildConnectionUrl({
        apiKey: "k",
        prompt: "The caller is discussing a billing issue."
      })
    );
    expect(p.get("prompt")).toBe("The caller is discussing a billing issue.");
  });

  it("forwards turn-detection and barge-in knobs only when set", () => {
    const p = parse(
      _buildConnectionUrl({
        apiKey: "k",
        minTurnSilence: 200,
        maxTurnSilence: 2000,
        interruptionDelay: 0,
        vadThreshold: 0.3
      })
    );
    expect(p.get("min_turn_silence")).toBe("200");
    expect(p.get("max_turn_silence")).toBe("2000");
    expect(p.get("interruption_delay")).toBe("0");
    expect(p.get("vad_threshold")).toBe("0.3");
  });

  it("forwards continuousPartials and languageDetection as booleans", () => {
    const p = parse(
      _buildConnectionUrl({
        apiKey: "k",
        continuousPartials: true,
        languageDetection: true
      })
    );
    expect(p.get("continuous_partials")).toBe("true");
    expect(p.get("language_detection")).toBe("true");
  });

  it("forwards an explicit continuousPartials: false", () => {
    const p = parse(
      _buildConnectionUrl({ apiKey: "k", continuousPartials: false })
    );
    expect(p.get("continuous_partials")).toBe("false");
  });

  it("forwards mode", () => {
    const p = parse(_buildConnectionUrl({ apiKey: "k", mode: "max_accuracy" }));
    expect(p.get("mode")).toBe("max_accuracy");
  });

  it("forwards agentContext as the connection-time agent_context seed", () => {
    const p = parse(
      _buildConnectionUrl({
        apiKey: "k",
        agentContext: "Sure — what date would you like to book?"
      })
    );
    expect(p.get("agent_context")).toBe(
      "Sure — what date would you like to book?"
    );
  });

  it("forwards previousContextNTurns, including 0 to disable carryover", () => {
    expect(
      parse(_buildConnectionUrl({ apiKey: "k", previousContextNTurns: 5 })).get(
        "previous_context_n_turns"
      )
    ).toBe("5");
    expect(
      parse(_buildConnectionUrl({ apiKey: "k", previousContextNTurns: 0 })).get(
        "previous_context_n_turns"
      )
    ).toBe("0");
  });

  it("JSON-encodes languageCodes into language_codes", () => {
    const p = parse(
      _buildConnectionUrl({ apiKey: "k", languageCodes: ["en", "es"] })
    );
    expect(p.get("language_codes")).toBe('["en","es"]');
  });

  it("forwards voiceFocus and voiceFocusThreshold", () => {
    const p = parse(
      _buildConnectionUrl({
        apiKey: "k",
        voiceFocus: "near-field",
        voiceFocusThreshold: 0.7
      })
    );
    expect(p.get("voice_focus")).toBe("near-field");
    expect(p.get("voice_focus_threshold")).toBe("0.7");
  });

  it("never sends a deprecated end_of_turn_confidence_threshold param", () => {
    const p = parse(_buildConnectionUrl({ apiKey: "k" }));
    expect(p.has("end_of_turn_confidence_threshold")).toBe(false);
  });
});

describe("AssemblyAISTT — construction validation", () => {
  it("throws when voiceFocusThreshold is set without voiceFocus", () => {
    expect(
      () => new AssemblyAISTT({ apiKey: "k", voiceFocusThreshold: 0.5 })
    ).toThrow(/voiceFocusThreshold.*voiceFocus/);
  });

  it("throws when voiceFocusThreshold is out of the [0, 1] range", () => {
    expect(
      () =>
        new AssemblyAISTT({
          apiKey: "k",
          voiceFocus: "near-field",
          voiceFocusThreshold: 1.1
        })
    ).toThrow(/voiceFocusThreshold/);
    expect(
      () =>
        new AssemblyAISTT({
          apiKey: "k",
          voiceFocus: "near-field",
          voiceFocusThreshold: -0.1
        })
    ).toThrow(/voiceFocusThreshold/);
  });

  it("accepts voiceFocusThreshold boundary values 0 and 1", () => {
    expect(
      () =>
        new AssemblyAISTT({
          apiKey: "k",
          voiceFocus: "near-field",
          voiceFocusThreshold: 0
        })
    ).not.toThrow();
    expect(
      () =>
        new AssemblyAISTT({
          apiKey: "k",
          voiceFocus: "far-field",
          voiceFocusThreshold: 1
        })
    ).not.toThrow();
  });

  it("throws when agentContext exceeds 1750 characters", () => {
    expect(
      () => new AssemblyAISTT({ apiKey: "k", agentContext: "x".repeat(1751) })
    ).toThrow(/agentContext.*1750/);
  });

  it("accepts an agentContext up to 1750 characters", () => {
    expect(
      () => new AssemblyAISTT({ apiKey: "k", agentContext: "x".repeat(1750) })
    ).not.toThrow();
  });

  it("throws when prompt exceeds 1750 characters", () => {
    expect(
      () => new AssemblyAISTT({ apiKey: "k", prompt: "x".repeat(1751) })
    ).toThrow(/prompt.*1750/);
  });

  it("throws when interruptionDelay is out of the [0, 1000] range", () => {
    expect(
      () => new AssemblyAISTT({ apiKey: "k", interruptionDelay: 1500 })
    ).toThrow(/interruptionDelay/);
    expect(
      () => new AssemblyAISTT({ apiKey: "k", interruptionDelay: -1 })
    ).toThrow(/interruptionDelay/);
  });

  it("throws when previousContextNTurns is out of the [0, 100] range", () => {
    expect(
      () => new AssemblyAISTT({ apiKey: "k", previousContextNTurns: 101 })
    ).toThrow(/previousContextNTurns/);
    expect(
      () => new AssemblyAISTT({ apiKey: "k", previousContextNTurns: -1 })
    ).toThrow(/previousContextNTurns/);
  });

  it("accepts a fully-populated valid configuration", () => {
    expect(
      () =>
        new AssemblyAISTT({
          apiKey: "k",
          mode: "balanced",
          prompt: "The caller is booking a hotel.",
          agentContext: "What date would you like to check in?",
          previousContextNTurns: 5,
          languageCodes: ["en"],
          voiceFocus: "near-field",
          voiceFocusThreshold: 0.7,
          minTurnSilence: 400,
          maxTurnSilence: 1280,
          interruptionDelay: 500,
          vadThreshold: 0.3,
          continuousPartials: true,
          languageDetection: true
        })
    ).not.toThrow();
  });
});

describe("_buildConnectionUrl — baseUrl override", () => {
  it("baseUrl replaces the default host", () => {
    const url = new URL(
      _buildConnectionUrl({
        apiKey: "k",
        baseUrl: "wss://streaming.eu.assemblyai.com/v3/ws"
      })
    );
    expect(url.host).toBe("streaming.eu.assemblyai.com");
    expect(url.pathname).toBe("/v3/ws");
  });

  it("baseUrl keeps the same hardcoded query params", () => {
    const p = parse(
      _buildConnectionUrl({
        apiKey: "k",
        baseUrl: "wss://gateway.example.com/v1/acct/gw/assemblyai/v3/ws"
      })
    );
    expect(p.get("speech_model")).toBe("universal-3-5-pro");
    expect(p.get("sample_rate")).toBe("16000");
    expect(p.get("encoding")).toBe("pcm_s16le");
  });
});

// Type-only check so AssemblyAISTTOptions is used in this file.
const _typeCheck: AssemblyAISTTOptions = { apiKey: "x" };
void _typeCheck;
void flush;
void setupMockFetch;

describe("AssemblyAISTT class shape", () => {
  it("createSession returns an object with feed(), close(), updateAgentContext()", () => {
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    expect(typeof session.feed).toBe("function");
    expect(typeof session.close).toBe("function");
    expect(typeof session.updateAgentContext).toBe("function");
  });
});

describe("AssemblyAISession — connect", () => {
  it("calls fetch with the built URL and Authorization header, then accepts the WebSocket", async () => {
    const { ws, calls } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "MY_KEY" });

    provider.createSession();
    await flush();

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    // Cloudflare's fetch WebSocket upgrade requires the http(s) scheme — the
    // canonical wss:// URL is rewritten to https:// for the fetch call.
    expect(url).toBe(
      _buildConnectionUrl({ apiKey: "MY_KEY" }).replace(/^wss:\/\//, "https://")
    );
    expect(url.startsWith("https://")).toBe(true);
    expect(url.startsWith("wss://")).toBe(false);
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Upgrade).toBe("websocket");
    expect(headers?.Authorization).toBe("MY_KEY");
    // Raw key — no Bearer or Token prefix.
    expect(headers?.Authorization).not.toMatch(/^Bearer /);
    expect(headers?.Authorization).not.toMatch(/^Token /);
    // Integration attribution in AssemblyAI's user-agent format.
    expect(headers?.["User-Agent"]).toBe(
      "AssemblyAI/1.0 (integration=Cloudflare-Agents)"
    );

    expect(ws.accept).toHaveBeenCalledTimes(1);
  });
});

describe("AssemblyAISession — Turn routing", () => {
  it("routes Turn{end_of_turn:false} to onInterim", async () => {
    const { ws } = setupMockFetch();
    const onInterim = vi.fn();
    const onUtterance = vi.fn();
    const provider = new AssemblyAISTT({ apiKey: "k" });

    provider.createSession({ onInterim, onUtterance });
    await flush();

    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "Turn",
          transcript: "hello",
          end_of_turn: false
        })
      })
    );

    expect(onInterim).toHaveBeenCalledWith("hello");
    expect(onUtterance).not.toHaveBeenCalled();
  });

  it("routes Turn{end_of_turn:true} to onUtterance", async () => {
    const { ws } = setupMockFetch();
    const onInterim = vi.fn();
    const onUtterance = vi.fn();
    const provider = new AssemblyAISTT({ apiKey: "k" });

    provider.createSession({ onInterim, onUtterance });
    await flush();

    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "Turn",
          transcript: "Hello world.",
          end_of_turn: true
        })
      })
    );

    expect(onUtterance).toHaveBeenCalledWith("Hello world.");
    expect(onInterim).not.toHaveBeenCalled();
  });

  it("ignores Turn events with an empty transcript", async () => {
    const { ws } = setupMockFetch();
    const onInterim = vi.fn();
    const onUtterance = vi.fn();
    const provider = new AssemblyAISTT({ apiKey: "k" });

    provider.createSession({ onInterim, onUtterance });
    await flush();

    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "Turn",
          transcript: "",
          end_of_turn: true
        })
      })
    );

    expect(onInterim).not.toHaveBeenCalled();
    expect(onUtterance).not.toHaveBeenCalled();
  });
});

describe("AssemblyAISession — SpeechStarted and language metadata", () => {
  it("routes SpeechStarted to onSpeechStart", async () => {
    const { ws } = setupMockFetch();
    const onSpeechStart = vi.fn();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    provider.createSession({ onSpeechStart });
    await flush();

    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "SpeechStarted" })
      })
    );

    expect(onSpeechStart).toHaveBeenCalledTimes(1);
  });

  it("fires onLanguageDetected when a Turn carries language metadata", async () => {
    const { ws } = setupMockFetch();
    const onLanguageDetected = vi.fn();
    const provider = new AssemblyAISTT({
      apiKey: "k",
      languageDetection: true,
      onLanguageDetected
    });
    provider.createSession({});
    await flush();

    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "Turn",
          transcript: "hola",
          end_of_turn: true,
          language_code: "es",
          language_confidence: 0.97
        })
      })
    );

    expect(onLanguageDetected).toHaveBeenCalledWith("es", 0.97);
  });

  it("does not fire onLanguageDetected when metadata is absent", async () => {
    const { ws } = setupMockFetch();
    const onLanguageDetected = vi.fn();
    const provider = new AssemblyAISTT({ apiKey: "k", onLanguageDetected });
    provider.createSession({});
    await flush();

    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "Turn",
          transcript: "hi",
          end_of_turn: true
        })
      })
    );

    expect(onLanguageDetected).not.toHaveBeenCalled();
  });
});

describe("AssemblyAISession — feed", () => {
  it("buffers audio fed before connect, then flushes on open", async () => {
    // Block fetch so the session is unconnected when feed() is first called.
    let resolveFetch: (resp: unknown) => void = () => {};
    const fetchPromise = new Promise((r) => {
      resolveFetch = r;
    });
    const ws = new MockWebSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchPromise)
    );

    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();

    const chunkA = pcm(3200, 1);
    const chunkB = pcm(3200, 2);
    session.feed(chunkA);
    session.feed(chunkB);

    expect(ws.send).not.toHaveBeenCalled();

    resolveFetch({ webSocket: ws });
    await flush();

    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.send).toHaveBeenNthCalledWith(1, chunkA);
    expect(ws.send).toHaveBeenNthCalledWith(2, chunkB);
  });

  it("sends audio immediately once connected", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    const chunk = pcm(3200, 7);
    session.feed(chunk);

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith(chunk);
  });
});

describe("AssemblyAISession — audio coalescing (50ms server minimum)", () => {
  // AssemblyAI terminates the session when a binary message carries <50ms of
  // audio (1600 bytes at 16kHz mono s16le), so sub-minimum frames must be
  // coalesced before sending.

  it("passes chunks ≥1600 bytes through untouched (same ArrayBuffer)", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    const exactMin = pcm(1600, 1);
    const browserChunk = pcm(3200, 2);
    session.feed(exactMin);
    session.feed(browserChunk);

    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.send.mock.calls[0][0]).toBe(exactMin);
    expect(ws.send.mock.calls[1][0]).toBe(browserChunk);
  });

  it("coalesces 20ms telephony frames until the 50ms minimum is reached", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    session.feed(pcm(640, 1));
    session.feed(pcm(640, 2));
    expect(ws.send).not.toHaveBeenCalled();

    session.feed(pcm(640, 3));
    expect(ws.send).toHaveBeenCalledTimes(1);

    const sent = new Uint8Array(ws.send.mock.calls[0][0] as ArrayBuffer);
    expect(sent.byteLength).toBe(1920);
    // Frames concatenated in feed order.
    expect(sent[0]).toBe(1);
    expect(sent[640]).toBe(2);
    expect(sent[1280]).toBe(3);
  });

  it("combines a held small frame with the next large chunk in order", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    session.feed(pcm(640, 1));
    expect(ws.send).not.toHaveBeenCalled();

    session.feed(pcm(3200, 2));
    expect(ws.send).toHaveBeenCalledTimes(1);

    const sent = new Uint8Array(ws.send.mock.calls[0][0] as ArrayBuffer);
    expect(sent.byteLength).toBe(3840);
    expect(sent[0]).toBe(1);
    expect(sent[639]).toBe(1);
    expect(sent[640]).toBe(2);
  });

  it("coalesces small frames buffered before connect when flushing on open", async () => {
    let resolveFetch: (resp: unknown) => void = () => {};
    const fetchPromise = new Promise((r) => {
      resolveFetch = r;
    });
    const ws = new MockWebSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchPromise)
    );

    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();

    // Five 20ms frames buffered while connecting: the first three flush as
    // one 1920-byte message on open; the remaining two (1280 bytes) are held.
    for (let i = 1; i <= 5; i++) session.feed(pcm(640, i));

    resolveFetch({ webSocket: ws });
    await flush();

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect((ws.send.mock.calls[0][0] as ArrayBuffer).byteLength).toBe(1920);

    // The held tail flushes once more audio crosses the minimum.
    session.feed(pcm(640, 6));
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect((ws.send.mock.calls[1][0] as ArrayBuffer).byteLength).toBe(1920);
  });

  it("drops a sub-minimum tail on close instead of sending it", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    session.feed(pcm(640, 1));
    session.close();

    // Only the Terminate control message goes out — no undersized audio.
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "Terminate" }));
  });
});

describe("AssemblyAISession — updateAgentContext", () => {
  it("sends an UpdateConfiguration with agent_context when connected", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    session.updateAgentContext!("What date would you like to book?");

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "UpdateConfiguration",
        agent_context: "What date would you like to book?"
      })
    );
  });

  it("does not send empty or whitespace-only agent context", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    session.updateAgentContext!("");
    session.updateAgentContext!("   ");

    expect(ws.send).not.toHaveBeenCalled();
  });

  it("is a no-op when previousContextNTurns is 0 (carryover disabled)", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({
      apiKey: "k",
      previousContextNTurns: 0
    });
    const session = provider.createSession();
    await flush();

    session.updateAgentContext!("What date would you like to book?");

    // Carryover is off — the server would discard agent_context, so skip the
    // pointless UpdateConfiguration entirely.
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("still sends agent context for other previousContextNTurns values", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({
      apiKey: "k",
      previousContextNTurns: 5
    });
    const session = provider.createSession();
    await flush();

    session.updateAgentContext!("What date would you like to book?");

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "UpdateConfiguration",
        agent_context: "What date would you like to book?"
      })
    );
  });

  it("caps agent context to the last 1750 characters", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    const long = "a".repeat(1000) + "b".repeat(1000);
    session.updateAgentContext!(long);

    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe("UpdateConfiguration");
    expect(sent.agent_context).toHaveLength(1750);
    expect(sent.agent_context).toBe(long.slice(-1750));
  });

  it("buffers a pre-connect update and sends only the latest on open", async () => {
    let resolveFetch: (resp: unknown) => void = () => {};
    const fetchPromise = new Promise((r) => {
      resolveFetch = r;
    });
    const ws = new MockWebSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchPromise)
    );

    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();

    session.updateAgentContext!("first");
    session.updateAgentContext!("second");
    expect(ws.send).not.toHaveBeenCalled();

    resolveFetch({ webSocket: ws });
    await flush();

    const configSends = ws.send.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("UpdateConfiguration"));
    expect(configSends).toHaveLength(1);
    expect(JSON.parse(configSends[0]).agent_context).toBe("second");
  });

  it("is a no-op after close()", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();
    session.close();
    ws.send.mockClear();

    session.updateAgentContext!("too late");

    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("AssemblyAISession — close", () => {
  it("sends Terminate then closes the WebSocket", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    session.close();

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "Terminate" }));
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("is idempotent on a second close()", async () => {
    const { ws } = setupMockFetch();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    session.close();
    session.close();
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("when called before the socket connects, the socket is accepted-and-closed once it arrives", async () => {
    let resolveFetch: (resp: unknown) => void = () => {};
    const fetchPromise = new Promise((r) => {
      resolveFetch = r;
    });
    const ws = new MockWebSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchPromise)
    );

    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();

    session.close(); // before fetch resolves
    resolveFetch({ webSocket: ws });
    await flush();

    expect(ws.accept).toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalled();
    // No Terminate sent — there was never a live connection.
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("AssemblyAISession — close diagnostics", () => {
  it("logs the close code and reason on an unexpected close", async () => {
    const { ws } = setupMockFetch();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = new AssemblyAISTT({ apiKey: "k" });
    provider.createSession();
    await flush();

    ws.dispatchEvent(
      Object.assign(new Event("close"), {
        code: 1008,
        reason: "Not authorized"
      })
    );

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("1008"));
    errSpy.mockRestore();
  });

  it("does not log when close() initiated the teardown", async () => {
    const { ws } = setupMockFetch();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    session.close();
    ws.dispatchEvent(
      Object.assign(new Event("close"), { code: 1000, reason: "" })
    );

    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("AssemblyAISession — server Error/Warning messages", () => {
  it("logs server Error messages with code and text", async () => {
    const { ws } = setupMockFetch();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = new AssemblyAISTT({ apiKey: "k" });
    provider.createSession();
    await flush();

    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "Error",
          error_code: 3006,
          error: "Input Validation Error"
        })
      })
    );

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Input Validation Error")
    );
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("3006"));
    errSpy.mockRestore();
  });

  it("logs server Warning messages", async () => {
    const { ws } = setupMockFetch();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new AssemblyAISTT({ apiKey: "k" });
    provider.createSession();
    await flush();

    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "Warning",
          warning_code: 1,
          warning: "Session approaching expiry"
        })
      })
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Session approaching expiry")
    );
    warnSpy.mockRestore();
  });

  it("logs the HTTP status and body when the upgrade yields no WebSocket", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            webSocket: undefined,
            status: 401,
            text: async () => "Unauthorized"
          }) as unknown as Response
      )
    );

    const provider = new AssemblyAISTT({ apiKey: "bad-key" });
    provider.createSession();
    await flush();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("401"));
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unauthorized")
    );
    errSpy.mockRestore();
  });
});

describe("AssemblyAISession — pre-connect buffer cap", () => {
  it("stops buffering audio once the cap is reached and logs once", async () => {
    // Fetch never resolves — the session stays unconnected.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {}))
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();

    // Cap is 960000 bytes = exactly 300 chunks of 3200 bytes.
    for (let i = 0; i < 310; i++) session.feed(pcm(3200));

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("dropping"));
    errSpy.mockRestore();
  });

  it("flushes at most the capped amount on connect", async () => {
    let resolveFetch: (resp: unknown) => void = () => {};
    const fetchPromise = new Promise((r) => {
      resolveFetch = r;
    });
    const ws = new MockWebSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchPromise)
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    for (let i = 0; i < 310; i++) session.feed(pcm(3200));

    resolveFetch({ webSocket: ws });
    await flush();

    // 300 buffered chunks pass through 1:1 (each ≥ the 50ms minimum).
    expect(ws.send).toHaveBeenCalledTimes(300);
    errSpy.mockRestore();
  });
});

describe("AssemblyAISession — send failure isolation", () => {
  it("does not throw out of feed() when the socket rejects the send", async () => {
    const { ws } = setupMockFetch();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    ws.send.mockImplementation(() => {
      throw new Error("socket is closing");
    });

    const provider = new AssemblyAISTT({ apiKey: "k" });
    const session = provider.createSession();
    await flush();

    expect(() => session.feed(pcm(3200))).not.toThrow();
    expect(() =>
      session.updateAgentContext!("What date would you like?")
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("send failed"),
      expect.anything()
    );
    errSpy.mockRestore();
  });
});

describe("AssemblyAISession — robustness", () => {
  it("ignores non-JSON messages without throwing", async () => {
    const { ws } = setupMockFetch();
    const onUtterance = vi.fn();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    provider.createSession({ onUtterance });
    await flush();

    expect(() => {
      ws.dispatchEvent(new MessageEvent("message", { data: "not json {{{" }));
    }).not.toThrow();
    expect(onUtterance).not.toHaveBeenCalled();
  });

  it("ignores binary message frames", async () => {
    const { ws } = setupMockFetch();
    const onUtterance = vi.fn();
    const provider = new AssemblyAISTT({ apiKey: "k" });
    provider.createSession({ onUtterance });
    await flush();

    expect(() => {
      ws.dispatchEvent(
        new MessageEvent("message", { data: new ArrayBuffer(8) })
      );
    }).not.toThrow();
    expect(onUtterance).not.toHaveBeenCalled();
  });
});
