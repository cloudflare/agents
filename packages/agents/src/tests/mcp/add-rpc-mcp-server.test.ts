import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getAgentByName } from "../..";

describe("addMcpServer with RPC binding — stable supplied ids", () => {
  it("uses a caller-supplied stable id as the server id", async () => {
    const agentStub = await getAgentByName(
      env.TestRpcMcpClientAgent,
      "test-rpc-stable-id"
    );
    const result = (await agentStub.testRpcStableSuppliedId()) as unknown as {
      success: boolean;
      id?: string;
      savedId?: string | null;
      toolNames?: string[];
      error?: string;
    };

    if (!result.success) {
      throw new Error(`Test failed: ${result.error}`);
    }

    expect(result.id).toBe("my-supplied-id");
    expect(result.savedId).toBe("my-supplied-id");
    expect(result.toolNames!.length).toBeGreaterThan(0);
  });

  it("normalizes a caller-supplied id (e.g. 'GitHub MCP!' → 'github-mcp')", async () => {
    const agentStub = await getAgentByName(
      env.TestRpcMcpClientAgent,
      "test-rpc-normalize-id"
    );
    const result =
      (await agentStub.testRpcNormalizesSuppliedId()) as unknown as {
        success: boolean;
        id?: string;
        error?: string;
      };

    if (!result.success) {
      throw new Error(`Test failed: ${result.error}`);
    }

    expect(result.id).toBe("github-mcp");
  });

  it("JIT-migrates an existing (name,url) row to a newly supplied stable id", async () => {
    const agentStub = await getAgentByName(
      env.TestRpcMcpClientAgent,
      "test-rpc-migrate-id"
    );
    const result =
      (await agentStub.testRpcSuppliedIdMigratesExistingNanoid()) as unknown as {
        success: boolean;
        firstId?: string;
        secondId?: string;
        storedIds?: string[];
        connectionsBefore?: number;
        connectionsAfter?: number;
        stableConnectionExists?: boolean;
        nanoidConnectionGone?: boolean;
        callOk?: boolean;
        error?: string;
      };

    if (!result.success) {
      throw new Error(`Test failed: ${result.error}`);
    }

    // Original call got a nanoid; second call asked for "migrated".
    expect(result.secondId).toBe("migrated");
    expect(result.firstId).not.toBe("migrated");

    // Exactly one row remains — the migrated one. No stale nanoid row.
    expect(result.storedIds).toEqual(["migrated"]);

    // Connection count unchanged; in-memory map renamed from nanoid → stable.
    expect(result.connectionsBefore).toBe(result.connectionsAfter);
    expect(result.stableConnectionExists).toBe(true);
    expect(result.nanoidConnectionGone).toBe(true);

    // Tool calls still route correctly post-migration.
    expect(result.callOk).toBe(true);
  });

  it("dedups when the same stable id is re-supplied for the same (name,url)", async () => {
    const agentStub = await getAgentByName(
      env.TestRpcMcpClientAgent,
      "test-rpc-dedup-stable"
    );
    const result =
      (await agentStub.testRpcSuppliedIdDedupsOnRepeat()) as unknown as {
        success: boolean;
        firstId?: string;
        secondId?: string;
        sameId?: boolean;
        error?: string;
      };

    if (!result.success) {
      throw new Error(`Test failed: ${result.error}`);
    }

    expect(result.firstId).toBe("stable");
    expect(result.sameId).toBe(true);
  });

  it("throws when a caller-supplied id collides with a different server", async () => {
    const agentStub = await getAgentByName(
      env.TestRpcMcpClientAgent,
      "test-rpc-collide-id"
    );
    const result =
      (await agentStub.testRpcSuppliedIdCollision()) as unknown as {
        success: boolean;
        firstId?: string;
        threw?: boolean;
        message?: string;
        error?: string;
      };

    if (!result.success) {
      throw new Error(`Test failed: ${result.error}`);
    }

    expect(result.firstId).toBe("collide");
    expect(result.threw).toBe(true);
    expect(result.message).toContain("already in use");
  });
});

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
