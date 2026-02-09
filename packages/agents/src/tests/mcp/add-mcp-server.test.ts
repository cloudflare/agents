import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { getAgentByName } from "../..";
import type { Env } from "../worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Type for the resolved arguments returned by test methods
// Note: This cast is needed because DurableObjectStub RPC typing doesn't preserve
// complex return types through the boundary. This is a test-infrastructure issue,
// not something end users will encounter when defining their own Agent methods.
type ResolvedArgs = {
  serverName: string;
  url: string;
  callbackHost?: string;
  agentsPrefix: string;
  transport?: { headers?: HeadersInit; type?: string };
  client?: unknown;
};

describe("addMcpServer callbackPath enforcement", () => {
  it("should throw when sendIdentityOnConnect is false and callbackPath is not provided", async () => {
    const agentStub = await getAgentByName(
      env.TestNoIdentityAgent,
      "test-no-callback-path"
    );
    const result =
      (await agentStub.testAddMcpServerWithoutCallbackPath()) as unknown as {
        threw: boolean;
        message: string;
      };

    expect(result.threw).toBe(true);
    expect(result.message).toContain(
      "callbackPath is required in addMcpServer options when sendIdentityOnConnect is false"
    );
  });

  it("should not throw enforcement error when sendIdentityOnConnect is false and callbackPath is provided", async () => {
    const agentStub = await getAgentByName(
      env.TestNoIdentityAgent,
      "test-with-callback-path"
    );
    // This may fail for other reasons (can't connect to remote MCP server) but should NOT
    // throw the callbackPath enforcement error
    const result =
      (await agentStub.testAddMcpServerWithCallbackPath()) as unknown as {
        threw: boolean;
        message: string;
      };

    expect(result.threw).toBe(true); // Throws for connection error, not enforcement
    expect(result.message).not.toContain(
      "callbackPath is required in addMcpServer options when sendIdentityOnConnect is false"
    );
  });
});

describe("addMcpServer API overloads", () => {
  describe("new options-based API", () => {
    it("should resolve options object with all fields", async () => {
      const agentStub = await getAgentByName(
        env.TestAddMcpServerAgent,
        "test-new-api-options"
      );
      const result = await agentStub.testNewApiWithOptions(
        "test-server",
        "https://mcp.example.com",
        "https://callback.example.com"
      );

      expect(result).toEqual({
        serverName: "test-server",
        url: "https://mcp.example.com",
        callbackHost: "https://callback.example.com",
        agentsPrefix: "custom-agents",
        transport: {
          type: "sse",
          headers: { Authorization: "Bearer test" }
        },
        client: undefined
      });
    });

    it("should use defaults for empty options object", async () => {
      const agentStub = await getAgentByName(
        env.TestAddMcpServerAgent,
        "test-new-api-minimal"
      );
      const result = await agentStub.testNewApiMinimal(
        "minimal-server",
        "https://minimal.example.com"
      );

      expect(result).toEqual({
        serverName: "minimal-server",
        url: "https://minimal.example.com",
        callbackHost: undefined,
        agentsPrefix: "agents", // default
        transport: undefined,
        client: undefined
      });
    });
  });

  describe("legacy positional API", () => {
    it("should resolve all positional parameters", async () => {
      const agentStub = await getAgentByName(
        env.TestAddMcpServerAgent,
        "test-legacy-api-options"
      );
      const result = await agentStub.testLegacyApiWithOptions(
        "legacy-server",
        "https://legacy.example.com",
        "https://legacy-callback.example.com"
      );

      expect(result).toEqual({
        serverName: "legacy-server",
        url: "https://legacy.example.com",
        callbackHost: "https://legacy-callback.example.com",
        agentsPrefix: "legacy-prefix",
        transport: {
          type: "streamable-http",
          headers: { "X-Custom": "value" }
        },
        client: undefined
      });
    });

    it("should use defaults when only callbackHost provided", async () => {
      const agentStub = await getAgentByName(
        env.TestAddMcpServerAgent,
        "test-legacy-api-minimal"
      );
      const result = await agentStub.testLegacyApiMinimal(
        "simple-server",
        "https://simple.example.com",
        "https://simple-callback.example.com"
      );

      expect(result).toEqual({
        serverName: "simple-server",
        url: "https://simple.example.com",
        callbackHost: "https://simple-callback.example.com",
        agentsPrefix: "agents", // default
        transport: undefined,
        client: undefined
      });
    });
  });

  describe("API equivalence", () => {
    it("should produce same results for equivalent new and legacy calls", async () => {
      const agentStub = await getAgentByName(
        env.TestAddMcpServerAgent,
        "test-api-equivalence"
      );

      // New API
      const newResult = (await agentStub.testNewApiWithOptions(
        "equiv-server",
        "https://equiv.example.com",
        "https://equiv-callback.example.com"
      )) as unknown as ResolvedArgs;

      // Legacy API with same values
      const legacyResult = (await agentStub.testLegacyApiWithOptions(
        "equiv-server",
        "https://equiv.example.com",
        "https://equiv-callback.example.com"
      )) as unknown as ResolvedArgs;

      // Both should resolve the same serverName, url, callbackHost
      expect(newResult.serverName).toBe(legacyResult.serverName);
      expect(newResult.url).toBe(legacyResult.url);
      expect(newResult.callbackHost).toBe(legacyResult.callbackHost);
    });
  });
});
