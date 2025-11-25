/**
 * Test worker for the Deep Agent System (sys/) control plane tests.
 *
 * This sets up a minimal AgentSystem with blueprints and tools
 * that mirror real usage patterns.
 */

import { AgentSystem } from "../../sys/system";
import { defineTool } from "../../sys/middleware";
import type { Agency } from "../../sys/agent/agency";
import type { SystemAgent } from "../../sys/agent";
import type { ToolContext } from "../../sys/types";
import { createMockProvider, MockResponses } from "./mock-provider";

// ============================================================================
// Mock Provider Setup
// ============================================================================

// Create a shared mock provider instance that tests can configure
export const mockProvider = createMockProvider({
  defaultResponse: { content: "Mock assistant response" }
});

// Pre-configure some useful triggers
mockProvider.addTrigger(
  "echo",
  MockResponses.toolCall("echo", { message: "test echo" })
);
mockProvider.addTrigger("add", MockResponses.toolCall("add", { a: 5, b: 3 }));
mockProvider.addTrigger(
  "calculate",
  MockResponses.toolCall("add", { a: 10, b: 20 })
);
mockProvider.addTrigger(
  "fail",
  MockResponses.toolCall("fail", { reason: "test error" })
);

// ============================================================================
// Test Tools
// ============================================================================

const echoTool = defineTool(
  {
    name: "echo",
    description: "Echoes back the input message",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to echo" }
      },
      required: ["message"]
    }
  },
  async (input: { message: string }, _ctx: ToolContext) => {
    return `Echo: ${input.message}`;
  }
);

const addTool = defineTool(
  {
    name: "add",
    description: "Adds two numbers together",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" }
      },
      required: ["a", "b"]
    }
  },
  async (input: { a: number; b: number }, _ctx: ToolContext) => {
    return `Result: ${input.a + input.b}`;
  }
);

const slowTool = defineTool(
  {
    name: "slow_operation",
    description: "A tool that takes time to complete",
    parameters: {
      type: "object",
      properties: {
        delay_ms: { type: "number", description: "Delay in milliseconds" }
      },
      required: ["delay_ms"]
    }
  },
  async (input: { delay_ms: number }, _ctx: ToolContext) => {
    await new Promise((resolve) => setTimeout(resolve, input.delay_ms));
    return `Completed after ${input.delay_ms}ms`;
  }
);

const errorTool = defineTool(
  {
    name: "fail",
    description: "A tool that always throws an error",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Error reason" }
      },
      required: ["reason"]
    }
  },
  async (input: { reason: string }, _ctx: ToolContext) => {
    throw new Error(`Intentional failure: ${input.reason}`);
  }
);

// ============================================================================
// Test Blueprints
// ============================================================================

const ASSISTANT_BLUEPRINT = {
  name: "assistant",
  description: "A helpful assistant agent for testing",
  prompt: `You are a helpful assistant for testing purposes.
When asked to echo something, use the echo tool.
When asked to add numbers, use the add tool.
Keep responses brief and to the point.`,
  tags: ["default", "test"]
};

const CALCULATOR_BLUEPRINT = {
  name: "calculator",
  description: "A calculator agent that performs arithmetic",
  prompt: `You are a calculator agent. Use the add tool to perform calculations.
Only respond with the calculation result, nothing else.`,
  tags: ["default", "math"]
};

const SLOW_AGENT_BLUEPRINT = {
  name: "slow-agent",
  description: "An agent that uses slow operations",
  prompt: "You use the slow_operation tool when asked to wait.",
  tags: ["default", "slow"]
};

// ============================================================================
// System Setup
// ============================================================================

const system = new AgentSystem({
  defaultModel: "mock-model",
  provider: mockProvider.provider
})
  .defaults()
  .addTool(echoTool, ["test"])
  .addTool(addTool, ["math", "test"])
  .addTool(slowTool, ["slow"])
  .addTool(errorTool, ["test"])
  .addAgent(ASSISTANT_BLUEPRINT)
  .addAgent(CALCULATOR_BLUEPRINT)
  .addAgent(SLOW_AGENT_BLUEPRINT);

// ============================================================================
// Exports
// ============================================================================

const {
  SystemAgent: TestSystemAgent,
  Agency: TestAgency,
  handler
} = system.export();

export { TestSystemAgent as SystemAgent, TestAgency as Agency };

export type Env = {
  SYSTEM_AGENT: DurableObjectNamespace<SystemAgent>;
  AGENCY: DurableObjectNamespace<Agency>;
  AGENCY_REGISTRY: KVNamespace;
};

export default handler;
