import { SERVER_INFO_META_KEY } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import {
  decodeMcpServerOptions,
  encodeMcpServerOptions,
  withMcpSession
} from "../../mcp/client-storage";

const statelessDiscovery = {
  supportedVersions: ["2026-07-28"],
  capabilities: { tools: {} },
  _meta: {
    [SERVER_INFO_META_KEY]: { name: "server", version: "1.0.0" }
  },
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

  it("drops an unsafe Stateless session that has no discovery advertisement", () => {
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

  it("round-trips Stateless session state with its discovery advertisement", () => {
    const connected = withMcpSession(
      { transport: { type: "streamable-http" } },
      {
        id: "session",
        protocolVersion: "2026-07-28",
        discoverResult: statelessDiscovery
      }
    );
    const restored = decodeMcpServerOptions(encodeMcpServerOptions(connected));

    expect(restored).toMatchObject({
      transport: {
        type: "streamable-http",
        sessionId: "session",
        protocolVersion: "2026-07-28"
      },
      discoverResult: statelessDiscovery
    });
    expect(withMcpSession(restored)).toEqual({
      client: undefined,
      transport: { type: "streamable-http" },
      retry: undefined,
      capabilities: undefined
    });
  });

  it("preserves RPC restore metadata when rewriting durable options", () => {
    const decoded = decodeMcpServerOptions(
      JSON.stringify({
        bindingName: "MCP_OBJECT",
        props: { userId: "user-1" },
        capabilities: { elicitation: { form: {} } }
      })
    );
    decoded.capabilities = undefined;

    expect(JSON.parse(encodeMcpServerOptions(decoded))).toEqual({
      bindingName: "MCP_OBJECT",
      props: { userId: "user-1" }
    });
  });
});
