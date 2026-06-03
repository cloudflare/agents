import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("createMcpOAuthProvider", () => {
  it("should return a DurableObjectOAuthClientProvider by default", async () => {
    const agentId = env.TestOAuthAgent.idFromName("test-default-provider");
    const agentStub = env.TestOAuthAgent.get(agentId);

    const result = await agentStub.testCreateMcpOAuthProvider(
      "http://example.com/callback"
    );

    expect(result.isDurableObjectProvider).toBe(true);
    expect(result.callbackUrl).toBe("http://example.com/callback");
  });

  it("should use a custom provider when overridden in a subclass", async () => {
    const agentId = env.TestCustomOAuthAgent.idFromName("test-custom-provider");
    const agentStub = env.TestCustomOAuthAgent.get(agentId);

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

    const result = await agentStub.testRestoreUsesOverride();

    expect(result.overrideWasCalled).toBe(true);
    expect(result.restoredProviderClientId).toBe("custom-client-id");
  });

  it("should resolve PKCE verifiers by OAuth callback state", async () => {
    const agentId = env.TestOAuthAgent.newUniqueId();
    const agentStub = env.TestOAuthAgent.get(agentId);

    const result = await agentStub.testPkceVerifierStateCorrelation();

    expect(result.state1Verifier).toMatch(/^verifier-one-/);
    expect(result.state2Verifier).toMatch(/^verifier-two-/);
    expect(result.staleStateIgnoredVerifier).toMatch(/^verifier-three-/);
    expect(result.challengeVerifierAfterFallbackCleanup).toMatch(
      /^verifier-four-/
    );
    expect(result.state1Verifier).not.toBe(result.state2Verifier);
    expect(result.staleStateIgnoredVerifier).not.toBe(result.state1Verifier);
    expect(result.staleStateIgnoredVerifier).not.toBe(result.state2Verifier);
    expect(result.challengeVerifierAfterFallbackCleanup).not.toBe(
      result.state1Verifier
    );
    expect(result.challengeVerifierAfterFallbackCleanup).not.toBe(
      result.state2Verifier
    );
    expect(result.challengeVerifierAfterFallbackCleanup).not.toBe(
      result.staleStateIgnoredVerifier
    );
  });
});
