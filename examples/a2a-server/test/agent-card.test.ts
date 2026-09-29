import { A2A_PROTOCOL_VERSION, AgentCard } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import {
  applyA2AServerFeatures,
  resolveA2AServerFeatures
} from "../src/runtime/features";
import { buildAgentCard } from "../src/agent-card";

describe("agent card", () => {
  it("resolves every optional server feature to disabled", () => {
    expect(resolveA2AServerFeatures()).toEqual({
      blockingSend: false,
      completionArtifacts: false,
      intermediateArtifacts: false,
      multiTurn: false,
      streaming: false,
      taskCancellation: false,
      taskListing: false
    });
  });

  it("derives its endpoint and advertises bearer authentication", () => {
    const card = AgentCard.toJSON(
      applyA2AServerFeatures(
        buildAgentCard("https://agent.example.com", cardOptions),
        resolveA2AServerFeatures({ streaming: true })
      )
    ) as Record<string, unknown>;

    expect(card).toMatchObject({
      supportedInterfaces: [
        {
          url: "https://agent.example.com/coordinator/a2a",
          protocolBinding: "JSONRPC",
          protocolVersion: A2A_PROTOCOL_VERSION
        }
      ],
      securitySchemes: {
        bearerAuth: {
          httpAuthSecurityScheme: {
            scheme: "Bearer",
            bearerFormat: "opaque"
          }
        }
      },
      capabilities: { streaming: true },
      defaultOutputModes: ["text/plain"]
    });
  });

  it("overrides conflicting base capabilities with disabled defaults", () => {
    const base = buildAgentCard("https://agent.example.com", cardOptions);
    if (!base.capabilities)
      throw new Error("Expected Agent Card capabilities.");
    base.capabilities.streaming = true;

    const card = applyA2AServerFeatures(base, resolveA2AServerFeatures());

    expect(card.capabilities).toMatchObject({
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false
    });
    expect(base.capabilities.streaming).toBe(true);
  });
});

const cardOptions = {
  description: "Coordinates a specialist review.",
  name: "Coordinator Agent",
  route: "coordinator" as const,
  skillId: "coordinate-specialist-review"
};
