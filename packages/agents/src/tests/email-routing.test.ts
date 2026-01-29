import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  createAddressBasedEmailResolver,
  createHeaderBasedEmailResolver,
  createCatchAllEmailResolver,
  routeAgentEmail,
  getAgentByName
} from "../index";
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
  });

  describe("createHeaderBasedEmailResolver", () => {
    it("should handle various case formats in message-id header", async () => {
      const resolver = createHeaderBasedEmailResolver();

      const testCases = [
        {
          messageId: "<agent123@EmailAgent.domain.com>",
          expectedName: "EmailAgent"
        },
        {
          messageId: "<agent123@email-agent.domain.com>",
          expectedName: "email-agent"
        },
        {
          messageId: "<agent123@CaseSensitiveAgent.domain.com>",
          expectedName: "CaseSensitiveAgent"
        }
      ];

      for (const { messageId, expectedName } of testCases) {
        const headers = new Headers({ "message-id": messageId });
        const email = createMockEmail({ headers });

        const result = await resolver(email, {});
        expect(result).toEqual({
          agentName: expectedName,
          agentId: "agent123"
        });
      }
    });

    it("should handle x-agent-name header with various cases", async () => {
      const resolver = createHeaderBasedEmailResolver();

      const headers = new Headers({
        "x-agent-name": "CaseSensitiveAgent",
        "x-agent-id": "test-id"
      });

      const email = createMockEmail({ headers });
      const result = await resolver(email, {});

      expect(result).toEqual({
        agentName: "CaseSensitiveAgent",
        agentId: "test-id"
      });
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

    it("should handle email replies with kebab-case in headers", async () => {
      // Email reply with kebab-case in message-id
      const headers = new Headers({
        "message-id": "<reply123@email-agent.company.com>",
        "in-reply-to": "<original@client.com>"
      });

      const replyEmail = createMockEmail({ headers });
      const resolver = createHeaderBasedEmailResolver();

      // This should route to EmailAgent even though the header uses kebab-case
      await routeAgentEmail(replyEmail, env, { resolver });
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
