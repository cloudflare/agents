import { describe, expect, it } from "vitest";

const pairs = [
  ["@cloudflare/voice", "agents/voice"],
  ["@cloudflare/voice/client", "agents/voice/client"],
  ["@cloudflare/voice/react", "agents/voice/react"],
  ["@cloudflare/voice/errors", "agents/voice/errors"]
] as const;

describe("@cloudflare/voice compatibility exports", () => {
  it.each(pairs)("re-exports %s from %s", async (legacyPath, agentsPath) => {
    // Import sequentially to avoid a Vite module-cache race between entrypoints.
    const legacy = await import(legacyPath);
    const canonical = await import(agentsPath);

    expect(Object.keys(legacy).sort()).toEqual(Object.keys(canonical).sort());
    for (const name of Object.keys(canonical)) {
      expect(legacy[name as keyof typeof legacy]).toBe(
        canonical[name as keyof typeof canonical]
      );
    }
  });
});
