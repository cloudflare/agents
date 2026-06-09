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
    it("promotes the verifier from the challenge key to the state-nonce key on a matching serverId", async () => {
      const result = await agent().testRedirectPromotesMatchingServerId();

      // Before redirect: verifier sits under the challenge key only.
      expect(result.challengeBefore).toBe(true);
      expect(result.stateBefore).toBe(false);
      // After redirect: promoted to the state-nonce key, challenge key deleted.
      expect(result.challengeAfter).toBe(false);
      expect(result.stateAfter).toBe(true);
      expect(result.storedVerifierMatches).toBe(true);
    });

    it("does not bind a verifier when the state's serverId belongs to another server", async () => {
      const result = await agent().testRedirectIgnoresServerIdMismatch();

      expect(result.challengeBefore).toBe(true);
      // Cross-server state must be ignored: verifier stays orphaned under the
      // challenge key and is never promoted to a state-nonce key.
      expect(result.challengeStillPresent).toBe(true);
      expect(result.stateVerifierCreated).toBe(false);
    });

    it("leaves the verifier orphaned and creates no state key when state or code_challenge is missing", async () => {
      const result =
        await agent().testRedirectWithoutStateOrChallengeKeepsOrphan();

      // Missing state: challenge key untouched, no state-nonce key created.
      expect(result.challengeAfterNoState).toBe(true);
      expect(result.stateAfterNoState).toBe(false);
      // Missing code_challenge: same — early-return, no promotion.
      expect(result.challengeAfterNoChallenge).toBe(true);
      expect(result.stateAfterNoChallenge).toBe(false);
    });

    it("does not throw when ids are unset", async () => {
      const result = await agent().testRedirectWithoutIdsDoesNotThrow();

      expect(result.authUrl).toContain("https://auth.example.com/authorize");
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
    it("deletes expired orphaned challenge verifiers before saving a new verifier", async () => {
      const result =
        await agent().testSaveCodeVerifierDeletesExpiredChallengeOrphans();

      expect(result.expiredBefore).toBe(true);
      expect(result.expiredAfter).toBe(false);
      expect(result.freshAfter).toBe(true);
    });

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

      // codeVerifierKeys excludes orphaned challenge keys by default (so a
      // no-context deleteCodeVerifier cannot delete another flow's pending
      // challenge verifier), but counts them under includeChallengeKeys.
      expect(result.defaultBefore).toBe(2);
      expect(result.withChallengeBefore).toBe(3);
      // invalidateCredentials("verifier") sweeps all three, including the orphan.
      expect(result.after).toBe(0);
    });
  });
});
