import { describe, it, expect } from "vitest";
import { __PACKAGE__ } from "../src/index";

describe("@cloudflare/voice-assemblyai", () => {
  it("loads", () => {
    expect(__PACKAGE__).toBe("@cloudflare/voice-assemblyai");
  });
});
