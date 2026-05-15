import { describe, it, expect } from "vitest";
import { TelnyxClient } from "../src/client.js";

describe("TelnyxClient", () => {
  it("uses default base URL when none provided", () => {
    const client = new TelnyxClient({ apiKey: "test-key" });

    expect(client.apiKey).toBe("test-key");
    expect(client.baseUrl).toBe("https://api.telnyx.com/v2");
  });

  it("allows overriding base URL", () => {
    const client = new TelnyxClient({
      apiKey: "test-key",
      baseUrl: "http://localhost:8080"
    });

    expect(client.baseUrl).toBe("http://localhost:8080");
  });
});
