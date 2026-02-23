import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("createMcpOAuthProvider", () => {
  it("should return a DurableObjectOAuthClientProvider by default", async () => {
    const agentId = env.TestOAuthAgent.idFromName("test-default-provider");
    const agentStub = env.TestOAuthAgent.get(agentId);

    await agentStub.setName("default");

    const result = await agentStub.testCreateMcpOAuthProvider(
      "http://example.com/callback"
    );

    expect(result.isDurableObjectProvider).toBe(true);
    expect(result.callbackUrl).toBe("http://example.com/callback");
  });

  it("should use a custom provider when overridden in a subclass", async () => {
    const agentId = env.TestCustomOAuthAgent.idFromName("test-custom-provider");
    const agentStub = env.TestCustomOAuthAgent.get(agentId);

    await agentStub.setName("default");

    const result = await agentStub.testCreateMcpOAuthProvider(
      "http://example.com/custom-callback"
    );

    expect(result.isDurableObjectProvider).toBe(false);
    expect(result.clientId).toBe("custom-client-id");
    expect(result.callbackUrl).toBe("http://example.com/custom-callback");
  });

  it("should use the custom provider override during restoreConnectionsFromStorage", async () => {
    const agentId = env.TestCustomOAuthAgent.idFromName(
      "test-restore-override"
    );
    const agentStub = env.TestCustomOAuthAgent.get(agentId);

    await agentStub.setName("restore-test");

    const result = await agentStub.testRestoreUsesOverride();

    expect(result.overrideWasCalled).toBe(true);
    expect(result.restoredProviderClientId).toBe("custom-client-id");
  });
});
