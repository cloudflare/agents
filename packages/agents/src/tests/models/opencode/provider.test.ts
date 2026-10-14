import { describe, expect, it } from "vitest";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "../../../models/opencode";

const binding = { aiGatewayLogId: null } as unknown as Ai;

describe("agents/models/opencode", () => {
  it("takes Workers AI ids, catalog ids and dynamic routes", () => {
    const ai = createAI({ binding });
    for (const id of [
      "@cf/moonshotai/kimi-k2.7-code",
      "anthropic/claude-opus-4.8",
      "dynamic/support"
    ] as const) {
      expect(ai(id)).toEqual({ id, providerID: CLOUDFLARE_PROVIDER_ID });
    }
  });

  it("refuses an id that names no model where it is named", () => {
    const ai = createAI({ binding });
    expect(() => ai("claude-opus-4-8" as never)).toThrow(
      /not a model id this provider knows/
    );
  });
});
