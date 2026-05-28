import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getAgentByName } from "../..";

describe("addMcpServer HTTP dedup (name + URL)", () => {
  it("should dedup when name and URL both match", async () => {
    const agentStub = await getAgentByName(
      env.TestHttpMcpDedupAgent,
      "test-same-name-same-url"
    );
    const result = (await agentStub.testSameNameSameUrl()) as unknown as {
      seededId: string;
      returnedId: string;
      deduped: boolean;
    };

    expect(result.deduped).toBe(true);
    expect(result.returnedId).toBe(result.seededId);
  });

  it("should NOT dedup when name matches but URL differs", async () => {
    const agentStub = await getAgentByName(
      env.TestHttpMcpDedupAgent,
      "test-same-name-diff-url"
    );
    const result = (await agentStub.testSameNameDifferentUrl()) as unknown as {
      seededId: string;
      returnedId: string | null;
      deduped: boolean;
      threwConnectionError?: boolean;
    };

    expect(result.deduped).toBe(false);
  });

  it("should dedup when URLs normalize to the same value (case-insensitive hostname)", async () => {
    const agentStub = await getAgentByName(
      env.TestHttpMcpDedupAgent,
      "test-url-normalization"
    );
    const result = (await agentStub.testUrlNormalization()) as unknown as {
      seededId: string;
      returnedId: string;
      deduped: boolean;
    };

    expect(result.deduped).toBe(true);
    expect(result.returnedId).toBe(result.seededId);
  });

  it("should NOT dedup when URL matches but name differs", async () => {
    const agentStub = await getAgentByName(
      env.TestHttpMcpDedupAgent,
      "test-diff-name-same-url"
    );
    const result = (await agentStub.testDifferentNameSameUrl()) as unknown as {
      seededId: string;
      returnedId: string | null;
      deduped: boolean;
      threwConnectionError?: boolean;
    };

    expect(result.deduped).toBe(false);
  });
});

describe("addMcpServer HTTP — stable supplied ids", () => {
  it("JIT-migrates an existing nanoid row + OAuth keys to the supplied stable id", async () => {
    const agentStub = await getAgentByName(
      env.TestHttpMcpDedupAgent,
      "test-http-migrate-id"
    );
    const result =
      (await agentStub.testHttpSuppliedIdMigratesNanoid()) as unknown as {
        oldId: string;
        resultId: string | null;
        storedIds: string[];
        oldKeyCount: number;
        newKeyCount: number;
      };

    // The server row is now keyed under the stable id, not the old nanoid.
    expect(result.resultId).toBe("stable-migrated");
    expect(result.storedIds).toEqual(["stable-migrated"]);

    // OAuth-style storage keys have been moved off the old prefix.
    expect(result.oldKeyCount).toBe(0);
    expect(result.newKeyCount).toBe(2);
  });

  it("normalizes a caller-supplied id and uses it as the new server id", async () => {
    const agentStub = await getAgentByName(
      env.TestHttpMcpDedupAgent,
      "test-http-stable-id"
    );
    const result = (await agentStub.testHttpSuppliedIdIsUsed()) as unknown as {
      ok: boolean;
      id: string | null;
      error?: string;
    };

    // connectToServer is mocked to fail, but we still expect the row to be
    // registered with the normalized id.
    expect(result.id).toBe("github-mcp");
  });

  it("throws when a caller-supplied id collides with a different (name,url)", async () => {
    const agentStub = await getAgentByName(
      env.TestHttpMcpDedupAgent,
      "test-http-collide-id"
    );
    const result =
      (await agentStub.testHttpSuppliedIdCollision()) as unknown as {
        seededId: string;
        threw: boolean;
        message: string;
      };

    expect(result.seededId).toBe("collide");
    expect(result.threw).toBe(true);
    expect(result.message).toContain("already in use");
  });
});
