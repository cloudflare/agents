import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { getAgentByName } from "../..";
import type { Env } from "../worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

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
