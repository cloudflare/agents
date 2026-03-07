/**
 * Integration tests for the Cloudflare Realtime SFU API.
 *
 * These tests call the real SFU API at rtc.live.cloudflare.com and require:
 *   CLOUDFLARE_REALTIME_SFU_APP_ID
 *   CLOUDFLARE_REALTIME_SFU_API_TOKEN
 *
 * Place these in `experimental/voice-agent/.env`.
 *
 * Run with: npm run test (from experimental/voice-agent/)
 * Skip with: SKIP_SFU_INTEGRATION=1 npm run test
 */
import { describe, expect, it, beforeAll } from "vitest";
import {
  createSFUSession,
  addSFUTracks,
  createSFUWebSocketAdapter,
  type SFUConfig
} from "../sfu-utils";

let config: SFUConfig;

const shouldSkip =
  !process.env.CLOUDFLARE_REALTIME_SFU_APP_ID ||
  !process.env.CLOUDFLARE_REALTIME_SFU_API_TOKEN ||
  process.env.SKIP_SFU_INTEGRATION === "1";

beforeAll(() => {
  if (shouldSkip) return;
  config = {
    appId: process.env.CLOUDFLARE_REALTIME_SFU_APP_ID!,
    apiToken: process.env.CLOUDFLARE_REALTIME_SFU_API_TOKEN!
  };
});

describe.skipIf(shouldSkip)("SFU API — session lifecycle", () => {
  it("creates a new session", async () => {
    const result = await createSFUSession(config);
    expect(result).toHaveProperty("sessionId");
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it("creates multiple independent sessions", async () => {
    const [s1, s2] = await Promise.all([
      createSFUSession(config),
      createSFUSession(config)
    ]);

    expect(s1.sessionId).not.toBe(s2.sessionId);
  });
});

describe.skipIf(shouldSkip)("SFU API — tracks", () => {
  it("rejects addTracks with invalid sessionId", async () => {
    await expect(
      addSFUTracks(config, "nonexistent-session-id", {
        sessionDescription: {
          type: "offer",
          sdp: "v=0\r\n"
        },
        tracks: []
      })
    ).rejects.toThrow(/SFU API error/);
  });

  it("rejects addTracks with malformed SDP on a valid session", async () => {
    const session = await createSFUSession(config);

    // The SFU should reject a nonsense SDP
    await expect(
      addSFUTracks(config, session.sessionId, {
        sessionDescription: {
          type: "offer",
          sdp: "this is not valid SDP"
        },
        tracks: [
          {
            location: "local",
            trackName: "test-audio",
            mid: "0"
          }
        ]
      })
    ).rejects.toThrow(/SFU API error/);
  });
});

describe.skipIf(shouldSkip)("SFU API — WebSocket adapter", () => {
  it("rejects adapter creation with no tracks", async () => {
    // The SFU requires at least one track reference
    await expect(createSFUWebSocketAdapter(config, [])).rejects.toThrow(
      /SFU API error/
    );
  });

  it("rejects adapter creation with invalid track references", async () => {
    await expect(
      createSFUWebSocketAdapter(config, [
        {
          location: "remote",
          sessionId: "nonexistent",
          trackName: "nonexistent"
        }
      ])
    ).rejects.toThrow(/SFU API error/);
  });
});

describe.skipIf(shouldSkip)("SFU API — auth", () => {
  it("rejects requests with invalid token", async () => {
    const badConfig: SFUConfig = {
      appId: config.appId,
      apiToken: "invalid-token-12345"
    };

    await expect(createSFUSession(badConfig)).rejects.toThrow(
      /SFU API error (401|403)/
    );
  });

  it("rejects requests with invalid app ID", async () => {
    const badConfig: SFUConfig = {
      appId: "nonexistent-app-id",
      apiToken: config.apiToken
    };

    await expect(createSFUSession(badConfig)).rejects.toThrow(/SFU API error/);
  });
});
