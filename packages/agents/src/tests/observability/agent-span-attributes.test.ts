import { describe, expect, it } from "vitest";
import { agentSpanAttributes } from "../../observability/agent-span-attributes";

describe("agentSpanAttributes", () => {
  it("adds the shared instrumentation and Agent identity attributes", () => {
    expect(
      agentSpanAttributes({
        agentClassName: "SupportAgent",
        sessionId: "do-id",
        sessionName: "customer-123"
      })
    ).toEqual({
      "instrumentation_scope.name": "agents",
      "instrumentation_scope.version": "1",
      "cloudflare.agents.session.id": "do-id",
      "cloudflare.agents.session.name": "customer-123",
      "gen_ai.agent.name": "SupportAgent"
    });
  });

  it("allows unnamed sessions", () => {
    expect(
      agentSpanAttributes({
        agentClassName: "SupportAgent",
        sessionId: "do-id",
        sessionName: undefined
      })
    ).toHaveProperty("cloudflare.agents.session.name", undefined);
  });
});
