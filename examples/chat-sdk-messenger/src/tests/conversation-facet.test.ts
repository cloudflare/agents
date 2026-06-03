import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { TestHostAgent } from "./worker";

type TestEnv = typeof env & {
  TestHostAgent: DurableObjectNamespace<TestHostAgent>;
};

function uniqueName(): string {
  return `chat-sdk-messenger-facet-${crypto.randomUUID()}`;
}

async function getHost(): Promise<TestHostAgent> {
  return (await getAgentByName(
    (env as TestEnv).TestHostAgent,
    uniqueName()
  )) as unknown as TestHostAgent;
}

describe("ConversationAgent facet", () => {
  it("can be created in the Vitest worker pool", async () => {
    const host = await getHost();

    await expect(host.testConversationFacet()).resolves.toBe("ok");
  });
});
