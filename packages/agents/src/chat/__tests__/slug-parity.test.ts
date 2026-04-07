/**
 * Verify that the agent name → URL slug conversion is consistent
 * between the server-side routing (camelCaseToKebabCase in agents/utils)
 * and the client-side standalone fetch (agentNameToKebab in ai-chat/react).
 *
 * Both functions must produce identical slugs for any agent class name,
 * or getAgentMessages() will construct URLs the server doesn't recognize.
 */
import { describe, it, expect } from "vitest";
import { camelCaseToKebabCase } from "../../utils";

function agentNameToKebab(name: string): string {
  if (name === name.toUpperCase() && name !== name.toLowerCase()) {
    return name.toLowerCase().replace(/_/g, "-");
  }
  let result = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  result = result.startsWith("-") ? result.slice(1) : result;
  return result.replace(/_/g, "-").replace(/-$/, "");
}

const testCases = [
  ["ChatAgent", "chat-agent"],
  ["MyAssistant", "my-assistant"],
  ["AIChatAgent", "a-i-chat-agent"],
  ["MCPServer", "m-c-p-server"],
  ["HTTPClient", "h-t-t-p-client"],
  ["SimpleBot", "simple-bot"],
  ["A", "a"],
  ["AB", "ab"],
  ["ThinkTestAgent", "think-test-agent"],
  ["TestAssistantAgentAgent", "test-assistant-agent-agent"],
  ["SCREAMING_CASE", "screaming-case"]
];

describe("agent name slug parity", () => {
  for (const [input, expected] of testCases) {
    it(`"${input}" → "${expected}" (both functions agree)`, () => {
      const serverSlug = camelCaseToKebabCase(input);
      const clientSlug = agentNameToKebab(input);

      expect(serverSlug).toBe(expected);
      expect(clientSlug).toBe(expected);
      expect(serverSlug).toBe(clientSlug);
    });
  }
});
