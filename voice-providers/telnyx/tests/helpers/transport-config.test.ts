import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTelnyxVoiceConfig } from "../../src/helpers/transport-config.js";
import { TelnyxCallBridge } from "../../src/providers/call-bridge.js";

vi.mock("../../src/providers/call-bridge.js", () => {
  const MockBridge = vi.fn().mockImplementation(function (config: unknown) {
    return {
      _config: config,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      connected: false,
      activeCall: null,
      onAudioLevel: null,
      onAudioData: null,
      playAudio: vi.fn(),
      answer: vi.fn(),
      hangup: vi.fn(),
      dial: vi.fn(),
      sendDTMF: vi.fn()
    };
  });

  return { TelnyxCallBridge: MockBridge };
});

const MOCK_TOKEN_RESPONSE = {
  token: "eyJhbGciOiJSUzI1NiJ9.test.sig",
  credentialId: "cred-abc-123",
  sipUsername: "gencredABC"
};

describe("createTelnyxVoiceConfig", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("fetches a JWT from the endpoint and creates a bridge", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
    );

    const result = await createTelnyxVoiceConfig({
      jwtEndpoint: "/api/telnyx-token"
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/telnyx-token");
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(result.bridge).toBeDefined();
    expect(result.audioInput).toBe(result.bridge);
    expect(result.credentialId).toBe("cred-abc-123");
    expect(result.sipUsername).toBe("gencredABC");
  });

  it("passes loginToken to TelnyxCallBridge", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
    );

    await createTelnyxVoiceConfig({ jwtEndpoint: "/api/telnyx-token" });

    expect(TelnyxCallBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        loginToken: "eyJhbGciOiJSUzI1NiJ9.test.sig"
      })
    );
  });

  it("forwards autoAnswer and debug to bridge config", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
    );

    await createTelnyxVoiceConfig({
      jwtEndpoint: "/api/telnyx-token",
      autoAnswer: true,
      debug: true
    });

    expect(TelnyxCallBridge).toHaveBeenCalledWith({
      loginToken: "eyJhbGciOiJSUzI1NiJ9.test.sig",
      autoAnswer: true,
      debug: true
    });
  });

  it("cleanup sends DELETE to the JWT endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
    );

    const result = await createTelnyxVoiceConfig({
      jwtEndpoint: "/api/telnyx-token"
    });

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    await result.cleanup();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("/api/telnyx-token");
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    const [, cleanupOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const body = cleanupOptions.body;
    expect(JSON.parse(String(body))).toEqual({ credentialId: "cred-abc-123" });
  });

  it("cleanup also stops the bridge", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
    );

    const result = await createTelnyxVoiceConfig({
      jwtEndpoint: "/api/telnyx-token"
    });

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    await result.cleanup();

    expect(result.bridge.stop).toHaveBeenCalled();
  });

  it("cleanup throws when credential revocation fails", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
    );

    const result = await createTelnyxVoiceConfig({
      jwtEndpoint: "/api/telnyx-token"
    });

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "nope" }), { status: 500 })
    );

    await expect(result.cleanup()).rejects.toThrow(
      "Failed to revoke Telnyx credential: 500"
    );
    expect(result.bridge.stop).toHaveBeenCalled();
  });

  it("throws when JWT fetch fails", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
    );

    await expect(
      createTelnyxVoiceConfig({ jwtEndpoint: "/api/telnyx-token" })
    ).rejects.toThrow("Failed to fetch JWT: 401");
  });

  it("throws when response has no token", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ credentialId: "cred-123" }), {
        status: 200
      })
    );

    await expect(
      createTelnyxVoiceConfig({ jwtEndpoint: "/api/telnyx-token" })
    ).rejects.toThrow("JWT response missing token");
  });

  it("uses absolute URL when provided", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
    );

    await createTelnyxVoiceConfig({
      jwtEndpoint: "https://my-worker.example.com/jwt"
    });

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://my-worker.example.com/jwt"
    );
  });
});
