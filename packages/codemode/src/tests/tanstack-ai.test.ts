import { describe, expect, it } from "vitest";
import { tanstackTools } from "../tanstack-ai";
import type { Tool as TanStackTool } from "@tanstack/ai";

describe("tanstackTools", () => {
  it("should keep tools with needsApproval: false", () => {
    const provider = tanstackTools([
      {
        name: "explicitly_safe",
        description: "Explicitly safe",
        needsApproval: false,
        execute: async () => ({ ok: true })
      } as unknown as TanStackTool
    ]);

    expect(provider.types).toContain("explicitly_safe");
    expect(provider.tools).toHaveProperty("explicitly_safe");
  });
});
