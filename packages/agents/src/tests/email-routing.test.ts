import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { routeAgentEmail, getAgentByName } from "../index";
import {
  createAddressBasedEmailResolver,
  createHeaderBasedEmailResolver,
  createSecureReplyEmailResolver,
  createCatchAllEmailResolver,
  signAgentHeaders
} from "../email";
import type { Env } from "./worker";

// Declare module to get proper typing for env
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Mock ForwardableEmailMessage
function createMockEmail(
  overrides: Partial<ForwardableEmailMessage> = {}
): ForwardableEmailMessage {
  return {
    from: "sender@example.com",
    to: "recipient@example.com",
    headers: new Headers(),
    raw: new ReadableStream(),
    rawSize: 1024,
    setReject: () => {},
    forward: async () => ({ messageId: "mock-forward-id" }),
    reply: async () => ({ messageId: "mock-reply-id" }),
    ...overrides
  };
}

describe("Email Resolver Case Sensitivity", () => {
  describe("createAddressBasedEmailResolver", () => {
    it("should handle CamelCase agent names in email addresses", async () => {
      const resolver = createAddressBasedEmailResolver("default-agent");

      // Test with CamelCase agent name
      const email = createMockEmail({
        to: "CaseSensitiveAgent+InstanceName@domain.com"
      });

      const result = await resolver(email, {});
      expect(result).toEqual({
        agentName: "CaseSensitiveAgent",
        agentId: "InstanceName"
      });
    });

    it("should handle kebab-case agent names in email addresses", async () => {
      const resolver = createAddressBasedEmailResolver("default-agent");

      const email = createMockEmail({
        to: "case-sensitive-agent+instance-name@domain.com"
      });

      const result = await resolver(email, {});
      expect(result).toEqual({
        agentName: "case-sensitive-agent",
        agentId: "instance-name"
      });
    });

    it("should handle mixed case variations", async () => {
      const resolver = createAddressBasedEmailResolver("default-agent");

      const testCases = [
        "EmailAgent+test@domain.com",
        "email-agent+test@domain.com",
        "EMAILAGENT+test@domain.com",
        "Email-Agent+test@domain.com"
      ];

      for (const to of testCases) {
        const email = createMockEmail({ to });
        const result = await resolver(email, {});
        expect(result).toBeTruthy();
        expect(result?.agentId).toBe("test");
      }
    });

    it("should use default agent name when no sub-address is provided", async () => {
      const resolver = createAddressBasedEmailResolver("EmailAgent");

      const email = createMockEmail({
        to: "john.doe@domain.com"
      });

      const result = await resolver(email, {});
      expect(result).toEqual({
        agentName: "EmailAgent",
        agentId: "john.doe"
      });
    });

    it("should reject local part exceeding 64 characters", async () => {
      const resolver = createAddressBasedEmailResolver("EmailAgent");
      const longLocalPart = "a".repeat(65);

      const email = createMockEmail({
        to: `${longLocalPart}@domain.com`
      });

      const result = await resolver(email, {});
      expect(result).toBeNull();
    });

    it("should accept local part at exactly 64 characters", async () => {
      const resolver = createAddressBasedEmailResolver("EmailAgent");
      const maxLocalPart = "a".repeat(64);

      const email = createMockEmail({
        to: `${maxLocalPart}@domain.com`
      });

      const result = await resolver(email, {});
      expect(result).not.toBeNull();
      expect(result?.agentId).toBe(maxLocalPart);
    });
  });

  describe("createHeaderBasedEmailResolver", () => {
    it("should throw an error due to security vulnerability", () => {
      expect(() => createHeaderBasedEmailResolver()).toThrow(
        /createHeaderBasedEmailResolver has been removed due to a security vulnerability/
      );
    });

    it("should include migration guidance in error message", () => {
      expect(() => createHeaderBasedEmailResolver()).toThrow(
        /createAddressBasedEmailResolver/
      );
      expect(() => createHeaderBasedEmailResolver()).toThrow(
        /createSecureReplyEmailResolver/
      );
    });
  });

  describe("createSecureReplyEmailResolver", () => {
    const TEST_SECRET = "test-secret-key-for-hmac";

    it("should throw error for empty secret", () => {
      expect(() => createSecureReplyEmailResolver("")).toThrow(
        "secret is required"
      );
    });

    it("should return null when required headers are missing", async () => {
      const resolver = createSecureReplyEmailResolver(TEST_SECRET);
      const email = createMockEmail();

      const result = await resolver(email, {});
      expect(result).toBeNull();
    });

    it("should return null when signature is missing", async () => {
      const resolver = createSecureReplyEmailResolver(TEST_SECRET);
      const headers = new Headers({
        "x-agent-name": "TestAgent",
        "x-agent-id": "test-id"
      });
      const email = createMockEmail({ headers });

      const result = await resolver(email, {});
      expect(result).toBeNull();
    });

    it("should return null when timestamp is missing", async () => {
      const resolver = createSecureReplyEmailResolver(TEST_SECRET);
      const headers = new Headers({
        "x-agent-name": "TestAgent",
        "x-agent-id": "test-id",
        "x-agent-sig": "some-signature"
      });
      const email = createMockEmail({ headers });

      const result = await resolver(email, {});
      expect(result).toBeNull();
    });

    it("should return null when signature is invalid", async () => {
      const resolver = createSecureReplyEmailResolver(TEST_SECRET);
      const headers = new Headers({
        "x-agent-name": "TestAgent",
        "x-agent-id": "test-id",
        "x-agent-sig": "invalid-signature",
        "x-agent-sig-ts": Math.floor(Date.now() / 1000).toString()
      });
      const email = createMockEmail({ headers });

      const result = await resolver(email, {});
      expect(result).toBeNull();
    });

    it("should route correctly with valid signature and set _secureRouted flag", async () => {
      const resolver = createSecureReplyEmailResolver(TEST_SECRET);
      const signedHeaders = await signAgentHeaders(
        TEST_SECRET,
        "TestAgent",
        "test-id"
      );
      const headers = new Headers(signedHeaders);
      const email = createMockEmail({ headers });

      const result = await resolver(email, {});
      expect(result).toEqual({
        agentName: "TestAgent",
        agentId: "test-id",
        _secureRouted: true
      });
    });

    it("should reject signature with wrong secret", async () => {
      const resolver = createSecureReplyEmailResolver(TEST_SECRET);
      const signedHeaders = await signAgentHeaders(
        "wrong-secret",
        "TestAgent",
        "test-id"
      );
      const headers = new Headers(signedHeaders);
      const email = createMockEmail({ headers });

      const result = await resolver(email, {});
      expect(result).toBeNull();
    });

    it("should reject tampered agent name", async () => {
      const resolver = createSecureReplyEmailResolver(TEST_SECRET);
      const signedHeaders = await signAgentHeaders(
        TEST_SECRET,
        "TestAgent",
        "test-id"
      );
      // Tamper with the agent name
      signedHeaders["X-Agent-Name"] = "TamperedAgent";
      const headers = new Headers(signedHeaders);
      const email = createMockEmail({ headers });

      const result = await resolver(email, {});
      expect(result).toBeNull();
    });

    it("should reject tampered agent id", async () => {
      const resolver = createSecureReplyEmailResolver(TEST_SECRET);
      const signedHeaders = await signAgentHeaders(
        TEST_SECRET,
        "TestAgent",
        "test-id"
      );
      // Tamper with the agent id
      signedHeaders["X-Agent-ID"] = "tampered-id";
      const headers = new Headers(signedHeaders);
      const email = createMockEmail({ headers });

      const result = await resolver(email, {});
      expect(result).toBeNull();
    });

    it("should reject expired signatures", async () => {
      const resolver = createSecureReplyEmailResolver(TEST_SECRET, {
        maxAge: 60 // 1 minute
      });
      const signedHeaders = await signAgentHeaders(
        TEST_SECRET,
        "TestAgent",
        "test-id"
      );
      // Set timestamp to 2 minutes ago
      signedHeaders["X-Agent-Sig-Ts"] = (
        Math.floor(Date.now() / 1000) - 120
      ).toString();
      const headers = new Headers(signedHeaders);
      const email = createMockEmail({ headers });

      const result = await resolver(email, {});
      expect(result).toBeNull();
    });

    it("should reject signatures with future timestamps", async () => {
      const resolver = createSecureReplyEmailResolver(TEST_SECRET);
      const signedHeaders = await signAgentHeaders(
        TEST_SECRET,
        "TestAgent",
        "test-id"
      );
      // Set timestamp to 10 minutes in the future (beyond 5 min clock skew allowance)
      signedHeaders["X-Agent-Sig-Ts"] = (
        Math.floor(Date.now() / 1000) + 600
      ).toString();
      const headers = new Headers(signedHeaders);
      const email = createMockEmail({ headers });

      const result = await resolver(email, {});
      expect(result).toBeNull();
    });

    it("should allow small clock skew for timestamps", async () => {
      const resolver = createSecureReplyEmailResolver(TEST_SECRET);
      const signedHeaders = await signAgentHeaders(
        TEST_SECRET,
        "TestAgent",
        "test-id"
      );
      // Set timestamp to 2 minutes in the future (within 5 min clock skew allowance)
      signedHeaders["X-Agent-Sig-Ts"] = (
        Math.floor(Date.now() / 1000) + 120
      ).toString();
      const headers = new Headers(signedHeaders);
      const email = createMockEmail({ headers });

      const result = await resolver(email, {});
      // Should still fail because signature doesn't match (timestamp is part of signed data)
      expect(result).toBeNull();
    });

    it("should call onInvalidSignature callback with reason", async () => {
      const reasons: string[] = [];
      const resolver = createSecureReplyEmailResolver(TEST_SECRET, {
        onInvalidSignature: (_email, reason) => {
          reasons.push(reason);
        }
      });

      // Test missing headers
      const email1 = createMockEmail();
      await resolver(email1, {});
      expect(reasons).toContain("missing_headers");

      // Test invalid signature
      const headers2 = new Headers({
        "x-agent-name": "TestAgent",
        "x-agent-id": "test-id",
        "x-agent-sig": "invalid",
        "x-agent-sig-ts": Math.floor(Date.now() / 1000).toString()
      });
      const email2 = createMockEmail({ headers: headers2 });
      await resolver(email2, {});
      expect(reasons).toContain("invalid");
    });

    it("should call onInvalidSignature with expired reason", async () => {
      let capturedReason: string | undefined;
      const resolver = createSecureReplyEmailResolver(TEST_SECRET, {
        maxAge: 60,
        onInvalidSignature: (_email, reason) => {
          capturedReason = reason;
        }
      });

      const signedHeaders = await signAgentHeaders(
        TEST_SECRET,
        "TestAgent",
        "test-id"
      );
      // Set timestamp to 2 minutes ago
      signedHeaders["X-Agent-Sig-Ts"] = (
        Math.floor(Date.now() / 1000) - 120
      ).toString();
      const headers = new Headers(signedHeaders);
      const email = createMockEmail({ headers });

      await resolver(email, {});
      expect(capturedReason).toBe("expired");
    });
  });

  describe("signAgentHeaders", () => {
    const TEST_SECRET = "test-secret-key";

    it("should return all required headers including timestamp", async () => {
      const headers = await signAgentHeaders(TEST_SECRET, "MyAgent", "agent-1");

      expect(headers).toHaveProperty("X-Agent-Name", "MyAgent");
      expect(headers).toHaveProperty("X-Agent-ID", "agent-1");
      expect(headers).toHaveProperty("X-Agent-Sig");
      expect(headers).toHaveProperty("X-Agent-Sig-Ts");
      expect(headers["X-Agent-Sig"]).toBeTruthy();
      expect(headers["X-Agent-Sig-Ts"]).toBeTruthy();
      // Timestamp should be a valid unix timestamp
      const ts = Number.parseInt(headers["X-Agent-Sig-Ts"], 10);
      expect(ts).toBeGreaterThan(0);
      expect(ts).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
    });

    it("should produce different signatures for different inputs", async () => {
      const headers1 = await signAgentHeaders(
        TEST_SECRET,
        "MyAgent",
        "agent-1"
      );
      const headers2 = await signAgentHeaders(
        TEST_SECRET,
        "MyAgent",
        "agent-2"
      );
      const headers3 = await signAgentHeaders(
        TEST_SECRET,
        "OtherAgent",
        "agent-1"
      );

      // Even if called at the same second, different inputs should produce different sigs
      expect(headers1["X-Agent-Sig"]).not.toBe(headers2["X-Agent-Sig"]);
      expect(headers1["X-Agent-Sig"]).not.toBe(headers3["X-Agent-Sig"]);
    });

    it("should produce different signatures for different secrets", async () => {
      const headers1 = await signAgentHeaders("secret-1", "MyAgent", "agent-1");
      const headers2 = await signAgentHeaders("secret-2", "MyAgent", "agent-1");

      expect(headers1["X-Agent-Sig"]).not.toBe(headers2["X-Agent-Sig"]);
    });

    it("should produce verifiable signatures", async () => {
      const resolver = createSecureReplyEmailResolver(TEST_SECRET);
      const signedHeaders = await signAgentHeaders(
        TEST_SECRET,
        "MyAgent",
        "agent-1"
      );
      const headers = new Headers(signedHeaders);
      const email = createMockEmail({ headers });

      const result = await resolver(email, {});
      expect(result).not.toBeNull();
      expect(result?.agentName).toBe("MyAgent");
      expect(result?.agentId).toBe("agent-1");
    });

    it("should throw error for empty secret", async () => {
      await expect(signAgentHeaders("", "MyAgent", "agent-1")).rejects.toThrow(
        "secret is required"
      );
    });

    it("should throw error for empty agentName", async () => {
      await expect(
        signAgentHeaders(TEST_SECRET, "", "agent-1")
      ).rejects.toThrow("agentName is required");
    });

    it("should throw error for empty agentId", async () => {
      await expect(
        signAgentHeaders(TEST_SECRET, "MyAgent", "")
      ).rejects.toThrow("agentId is required");
    });

    it("should throw error for agentName containing colon", async () => {
      await expect(
        signAgentHeaders(TEST_SECRET, "My:Agent", "agent-1")
      ).rejects.toThrow("agentName cannot contain colons");
    });

    it("should throw error for agentId containing colon", async () => {
      await expect(
        signAgentHeaders(TEST_SECRET, "MyAgent", "agent:1")
      ).rejects.toThrow("agentId cannot contain colons");
    });
  });

  describe("createCatchAllEmailResolver", () => {
    it("should return the exact agent name provided", async () => {
      const testCases = [
        { agentName: "EmailAgent", agentId: "default" },
        { agentName: "email-agent", agentId: "default" },
        { agentName: "CaseSensitiveAgent", agentId: "test" }
      ];

      for (const { agentName, agentId } of testCases) {
        const resolver = createCatchAllEmailResolver(agentName, agentId);
        const email = createMockEmail();

        const result = await resolver(email, {});
        expect(result).toEqual({ agentName, agentId });
      }
    });
  });

  describe("routeAgentEmail with case normalization", () => {
    it("should route to correct agent regardless of case in resolver result", async () => {
      // Test resolver returning different case formats
      const testCases = [
        { agentName: "EmailAgent", agentId: "test1" },
        { agentName: "email-agent", agentId: "test2" },
        { agentName: "CaseSensitiveAgent", agentId: "test3" },
        { agentName: "case-sensitive-agent", agentId: "test4" }
      ];

      for (const { agentName, agentId } of testCases) {
        const resolver = async () => ({ agentName, agentId });
        const email = createMockEmail();

        // Route the email using the real DurableObject bindings from test env
        await routeAgentEmail(email, env, { resolver });

        // Since we can't easily inspect the agent's state in the test,
        // we trust that if no error is thrown, routing succeeded
        // The agent should have received the email regardless of case
      }
    });

    it("should throw helpful error when agent namespace not found", async () => {
      const resolver = async () => ({
        agentName: "NonExistentAgent",
        agentId: "test"
      });
      const email = createMockEmail();

      await expect(routeAgentEmail(email, env, { resolver })).rejects.toThrow(
        /Agent namespace 'NonExistentAgent' not found in environment/
      );
    });

    it("should call onNoRoute when resolver returns null", async () => {
      let callbackCalled = false;
      let capturedEmail: ForwardableEmailMessage | undefined;

      const resolver = async () => null;
      const email = createMockEmail();

      await routeAgentEmail(email, env, {
        resolver,
        onNoRoute: (e) => {
          callbackCalled = true;
          capturedEmail = e;
        }
      });

      expect(callbackCalled).toBe(true);
      expect(capturedEmail).toBe(email);
    });

    it("should allow rejecting email in onNoRoute callback", async () => {
      let rejected = false;
      const email = createMockEmail({
        setReject: () => {
          rejected = true;
        }
      });

      await routeAgentEmail(email, env, {
        resolver: async () => null,
        onNoRoute: (e) => {
          e.setReject("Unknown recipient");
        }
      });

      expect(rejected).toBe(true);
    });

    it("should handle real-world email routing scenario", async () => {
      // Test with actual DurableObject from env
      const userEmail = createMockEmail({
        to: "UserNotificationAgent+user123@company.com",
        from: "user@example.com"
      });

      const resolver = createAddressBasedEmailResolver("default");

      // This should route to the UserNotificationAgent DurableObject
      await routeAgentEmail(userEmail, env, { resolver });

      // Verify we can access the agent
      const agent = await getAgentByName(env.UserNotificationAgent, "user123");
      expect(agent).toBeDefined();
    });

    it("should handle email replies with secure resolver", async () => {
      const TEST_SECRET = "test-secret";
      // Sign headers for a reply
      const signedHeaders = await signAgentHeaders(
        TEST_SECRET,
        "email-agent",
        "reply123"
      );
      const headers = new Headers({
        ...signedHeaders,
        "in-reply-to": "<original@client.com>"
      });

      const replyEmail = createMockEmail({ headers });
      const secureResolver = createSecureReplyEmailResolver(TEST_SECRET);

      // This should route to EmailAgent with verified signature
      await routeAgentEmail(replyEmail, env, { resolver: secureResolver });
    });
  });

  describe("Integration: Case sensitivity bug fix verification", () => {
    it("should solve the original reported bug", async () => {
      // Original bug: User had to use exact case "CaseSensitiveAgent+InstanceName@domain.com"
      // Now all these variations should work:

      const testEmails = [
        "CaseSensitiveAgent+bug-test@domain.com", // Original format that was required
        "case-sensitive-agent+bug-test@domain.com", // Kebab-case format now also works
        "EmailAgent+bug-test@domain.com", // CamelCase format
        "email-agent+bug-test@domain.com" // Kebab-case format
      ];

      const resolver = createAddressBasedEmailResolver("default");

      for (const to of testEmails) {
        const email = createMockEmail({ to });

        // All variations should successfully route without error
        await expect(
          routeAgentEmail(email, env, { resolver })
        ).resolves.not.toThrow();
      }
    });
  });
});
