import { describe, expect, it, vi } from "vitest";
import {
  decodeMcpServerOptions,
  encodeMcpServerOptions,
  withMcpSession
} from "../../mcp/client-storage";

const modernDiscovery = {
  supportedVersions: ["2026-07-28"],
  capabilities: { tools: {} },
  serverInfo: { name: "server", version: "1.0.0" },
  resultType: "complete" as const
};

describe("MCP client storage codec", () => {
  it("persists only the declared durable client and transport options", () => {
    const encoded = encodeMcpServerOptions({
      client: {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: "auto" },
        jsonSchemaValidator: { getValidator: vi.fn() },
        listChanged: {
          tools: { onChanged: vi.fn() }
        },
        responseCacheStore: {} as never
      },
      transport: {
        type: "streamable-http",
        skipIssuerMetadataValidation: true,
        fetch: vi.fn(),
        authProvider: {} as never
      }
    });

    expect(JSON.parse(encoded)).toEqual({
      client: {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: "auto" }
      },
      transport: {
        type: "streamable-http",
        skipIssuerMetadataValidation: true
      }
    });
  });

  it("drops an unsafe modern session that has no discovery advertisement", () => {
    expect(
      decodeMcpServerOptions(
        JSON.stringify({
          transport: {
            type: "streamable-http",
            sessionId: "session",
            protocolVersion: "2026-07-28"
          }
        })
      )
    ).toEqual({
      client: undefined,
      transport: { type: "streamable-http" },
      discoverResult: undefined,
      retry: undefined,
      capabilities: undefined
    });
  });

  it("adds and clears modern session state atomically", () => {
    const connected = withMcpSession(
      { transport: { type: "streamable-http" } },
      {
        id: "session",
        protocolVersion: "2026-07-28",
        discoverResult: modernDiscovery
      }
    );
    expect(connected).toMatchObject({
      transport: {
        type: "streamable-http",
        sessionId: "session",
        protocolVersion: "2026-07-28"
      },
      discoverResult: modernDiscovery
    });
    expect(withMcpSession(connected)).toEqual({
      transport: { type: "streamable-http" }
    });
  });
});
