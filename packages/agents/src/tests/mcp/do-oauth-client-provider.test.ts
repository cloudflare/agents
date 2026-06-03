import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Provider-level branch coverage for DurableObjectOAuthClientProvider's
// PKCE-verifier-by-callback-state logic. These run inside TestOAuthAgent so the
// provider uses real DurableObjectStorage (the behavior cannot be faithfully
// reproduced with an in-memory mock).
describe("DurableObjectOAuthClientProvider PKCE binding", () => {
  function agent() {
    const id = env.TestOAuthAgent.newUniqueId();
    return env.TestOAuthAgent.get(id);
  }

  describe("redirectToAuthorization binding guard", () => {
    it("does not bind a verifier when the state's serverId belongs to another server", async () => {
      const result = await agent().testRedirectIgnoresServerIdMismatch();

      expect(result.challengeBefore).toBe(true);
      // Cross-server state must be ignored: verifier stays orphaned under the
      // challenge key and is never promoted to a state-nonce key.
      expect(result.challengeStillPresent).toBe(true);
      expect(result.stateVerifierCreated).toBe(false);
    });

    it("leaves the verifier under the challenge key when state or code_challenge is missing", async () => {
      const result =
        await agent().testRedirectWithoutStateOrChallengeKeepsOrphan();

      expect(result.afterNoState).toBe(true);
      expect(result.afterNoChallenge).toBe(true);
    });
  });

  describe("codeVerifier resolution without ALS context", () => {
    it("throws loudly when multiple verifiers are pending (no silent wrong-verifier)", async () => {
      const result = await agent().testCodeVerifierMultiplePendingThrows();

      expect(result.threw).toBe(true);
      expect(result.message).toContain("Multiple OAuth code verifiers");
    });

    it("resolves the sole pending verifier (deprecated reconnect happy path)", async () => {
      const result = await agent().testCodeVerifierSinglePendingFallback();

      expect(result.resolved).toBe(result.expected);
    });

    it("throws a state-specific error inside a state context with no stored verifier", async () => {
      const result =
        await agent().testCodeVerifierStateContextNoVerifierThrows();

      expect(result.threw).toBe(true);
      expect(result.message).toContain(
        "No code verifier found for OAuth state"
      );
    });
  });

  describe("expiry cleanup", () => {
    it("deletes the bound state verifier when checkState finds the state expired", async () => {
      const result = await agent().testCheckStateExpiredDeletesVerifier();

      expect(result.valid).toBe(false);
      expect(result.error).toBe("State expired");
      expect(result.stateKeyExists).toBe(false);
      expect(result.verifierKeyExists).toBe(false);
    });

    it("deletes and throws when resolving an expired state verifier", async () => {
      const result = await agent().testCodeVerifierStateExpiredThrows();

      expect(result.threw).toBe(true);
      expect(result.message).toContain("Code verifier expired");
      expect(result.verifierKeyExists).toBe(false);
    });
  });

  describe("invalidateCredentials", () => {
    it("sweeps every pending verifier (bound and orphaned), not a single slot", async () => {
      const result = await agent().testInvalidateVerifierDeletesAllPending();

      expect(result.before).toBe(3);
      expect(result.after).toBe(0);
    });
  });
});
