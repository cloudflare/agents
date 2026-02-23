import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { getAgentByName } from "../..";
import type { Env } from "../worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("addMcpServer with RPC binding", () => {
  it("should connect to McpAgent via RPC and discover tools", async () => {
    const agentStub = await getAgentByName(
      env.TestRpcMcpClientAgent,
      "test-rpc-discover"
    );
    const result = (await agentStub.testAddRpcMcpServer()) as unknown as {
      success: boolean;
      toolNames?: string[];
      error?: string;
    };

    if (!result.success) {
      throw new Error(`Test failed: ${result.error}`);
    }

    expect(result.toolNames).toBeDefined();
    expect(result.toolNames!.length).toBeGreaterThan(0);
    expect(result.toolNames).toContain("greet");
    expect(result.toolNames).toContain("getPropsTestValue");
  });

  it("should call a tool on McpAgent via RPC and get correct response", async () => {
    const agentStub = await getAgentByName(
      env.TestRpcMcpClientAgent,
      "test-rpc-call-tool"
    );
    const result = (await agentStub.testCallToolViaRpc()) as unknown as {
      success: boolean;
      result?: { content: Array<{ type: string; text: string }> };
      error?: string;
    };

    if (!result.success) {
      throw new Error(`Test failed: ${result.error}`);
    }

    expect(result.result).toBeDefined();
    expect(result.result!.content).toBeDefined();
    expect(result.result!.content[0].type).toBe("text");
    expect(result.result!.content[0].text).toContain("RPC User");
  });

  it("should persist RPC server info to storage for hibernation recovery", async () => {
    const agentStub = await getAgentByName(
      env.TestRpcMcpClientAgent,
      "test-rpc-persist"
    );
    const result =
      (await agentStub.testRpcServerPersistsToStorage()) as unknown as {
        success: boolean;
        bindingName?: string;
        props?: Record<string, unknown>;
        serverUrl?: string;
        error?: string;
      };

    if (!result.success) {
      throw new Error(`Test failed: ${result.error}`);
    }

    expect(result.bindingName).toBe("MCP_OBJECT");
    expect(result.props).toEqual({ testValue: "persisted-value" });
    expect(result.serverUrl).toMatch(/^rpc:/);
  });

  it("should restore RPC connections after simulated hibernation with stable ID", async () => {
    const agentStub = await getAgentByName(
      env.TestRpcMcpClientAgent,
      "test-rpc-hibernate"
    );
    const result =
      (await agentStub.testRpcServerRestoresAfterHibernation()) as unknown as {
        success: boolean;
        idBefore?: string;
        idAfter?: string;
        sameId?: boolean;
        toolsBefore?: string[];
        toolsDuring?: string[];
        toolsAfter?: string[];
        connectionCountBefore?: number;
        connectionCountAfter?: number;
        result?: { content: Array<{ type: string; text: string }> };
        error?: string;
      };

    if (!result.success) {
      throw new Error(`Test failed: ${result.error}`);
    }

    expect(result.sameId).toBe(true);
    expect(result.connectionCountBefore).toBe(1);
    expect(result.connectionCountAfter).toBe(1);
    expect(result.toolsBefore!.length).toBeGreaterThan(0);
    expect(result.toolsDuring).toEqual([]);
    expect(result.toolsAfter!.length).toBeGreaterThan(0);
    expect(result.toolsAfter!.length).toBe(result.toolsBefore!.length);
    expect(result.result!.content[0].text).toBe("survives-hibernation");
  });

  it("should deduplicate repeated addMcpServer calls for the same server", async () => {
    const agentStub = await getAgentByName(
      env.TestRpcMcpClientAgent,
      "test-rpc-dedup"
    );
    const result = (await agentStub.testRpcServerDeduplicates()) as unknown as {
      success: boolean;
      id1?: string;
      id2?: string;
      sameId?: boolean;
      connectionCount?: number;
      error?: string;
    };

    if (!result.success) {
      throw new Error(`Test failed: ${result.error}`);
    }

    expect(result.sameId).toBe(true);
    expect(result.connectionCount).toBe(1);
  });

  it("should clean up connection and storage when removing an RPC server", async () => {
    const agentStub = await getAgentByName(
      env.TestRpcMcpClientAgent,
      "test-rpc-remove"
    );
    const result = (await agentStub.testRemoveRpcMcpServer()) as unknown as {
      success: boolean;
      toolsBefore?: number;
      toolsAfter?: number;
      storageBefore?: number;
      storageAfter?: number;
      connectionExists?: boolean;
      error?: string;
    };

    if (!result.success) {
      throw new Error(`Test failed: ${result.error}`);
    }

    expect(result.toolsBefore).toBeGreaterThan(0);
    expect(result.toolsAfter).toBe(0);
    expect(result.storageBefore).toBeGreaterThan(0);
    expect(result.storageAfter).toBe(0);
    expect(result.connectionExists).toBe(false);
  });

  it("should pass props to McpAgent via RPC and verify they arrive", async () => {
    const agentStub = await getAgentByName(
      env.TestRpcMcpClientAgent,
      "test-rpc-props"
    );
    const result = (await agentStub.testPropsPassedViaRpc()) as unknown as {
      success: boolean;
      result?: { content: Array<{ type: string; text: string }> };
      error?: string;
    };

    if (!result.success) {
      throw new Error(`Test failed: ${result.error}`);
    }

    expect(result.result).toBeDefined();
    expect(result.result!.content[0].type).toBe("text");
    expect(result.result!.content[0].text).toBe("from-rpc-client");
  });
});
