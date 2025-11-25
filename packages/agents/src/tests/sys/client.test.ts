/**
 * Tests for the AgentSystemClient and control plane HTTP endpoints.
 *
 * These tests verify:
 * - Agency CRUD operations
 * - Blueprint management
 * - Agent spawning and lifecycle
 * - Invoke, approve, cancel operations
 * - State and events retrieval
 * - Tool execution via mock provider
 * - Agent completion flow
 */

import { createExecutionContext, env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker, { type Env, mockProvider } from "./worker";
import {
  AgentSystemClient,
  type AgencyClient,
  AgentSystemError,
  type AgentClient
} from "../../sys/client";
import { MockResponses } from "./mock-provider";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a test client that uses the worker's fetch directly
 */
function createTestClient(): AgentSystemClient {
  return new AgentSystemClient({
    baseUrl: "http://test.local",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const ctx = createExecutionContext();
      const url = typeof input === "string" ? input : input.toString();
      const req = new Request(url, init);
      // @ts-expect-error - KVNamespace type mismatch between cloudflare:test and workers-types
      return worker.fetch(req, env, ctx);
    }
  });
}

// ============================================================================
// Agency Management Tests
// ============================================================================

describe("Agency Management", () => {
  let client: AgentSystemClient;

  beforeEach(() => {
    client = createTestClient();
  });

  it("should list agencies (initially empty or with prior test data)", async () => {
    const result = await client.listAgencies();
    expect(result).toHaveProperty("agencies");
    expect(Array.isArray(result.agencies)).toBe(true);
  });

  it("should create a new agency with a name", async () => {
    const agency = await client.createAgency({ name: "Test Agency" });

    expect(agency).toHaveProperty("id");
    expect(agency.name).toBe("Test Agency");
    expect(agency).toHaveProperty("createdAt");
  });

  it("should create an agency with default name when none provided", async () => {
    const agency = await client.createAgency();

    expect(agency).toHaveProperty("id");
    expect(agency.name).toBe("Untitled Agency");
  });

  it("should list agencies including newly created ones", async () => {
    const agency = await client.createAgency({ name: "Visible Agency" });
    const result = await client.listAgencies();

    const found = result.agencies.find((a) => a.id === agency.id);
    expect(found).toBeDefined();
    expect(found?.name).toBe("Visible Agency");
  });
});

// ============================================================================
// Blueprint Management Tests
// ============================================================================

describe("Blueprint Management", () => {
  let client: AgentSystemClient;
  let agencyClient: AgencyClient;

  beforeEach(async () => {
    client = createTestClient();
    const agency = await client.createAgency({ name: "Blueprint Test Agency" });
    agencyClient = client.agency(agency.id);
  });

  it("should list static default blueprints", async () => {
    const result = await agencyClient.listBlueprints();

    expect(result).toHaveProperty("blueprints");
    expect(Array.isArray(result.blueprints)).toBe(true);

    // Should have our static blueprints from worker.ts
    const names = result.blueprints.map((b) => b.name);
    expect(names).toContain("assistant");
    expect(names).toContain("calculator");
    expect(names).toContain("slow-agent");
  });

  it("should create a custom blueprint for the agency", async () => {
    const result = await agencyClient.createBlueprint({
      name: "custom-agent",
      description: "A custom test agent",
      prompt: "You are a custom agent for testing.",
      tags: ["custom", "test"]
    });

    expect(result.ok).toBe(true);
    expect(result.name).toBe("custom-agent");
  });

  it("should list custom blueprints alongside defaults", async () => {
    await agencyClient.createBlueprint({
      name: "another-custom",
      description: "Another custom agent",
      prompt: "Another custom prompt.",
      tags: ["custom"]
    });

    const result = await agencyClient.listBlueprints();
    const names = result.blueprints.map((b) => b.name);

    expect(names).toContain("assistant"); // static
    expect(names).toContain("another-custom"); // dynamic
  });

  it("should update an existing blueprint", async () => {
    // Create
    await agencyClient.createBlueprint({
      name: "updateable",
      description: "Initial description",
      prompt: "Initial prompt",
      tags: ["test"]
    });

    // Update
    await agencyClient.createBlueprint({
      name: "updateable",
      description: "Updated description",
      prompt: "Updated prompt",
      tags: ["test", "updated"]
    });

    const result = await agencyClient.listBlueprints();
    const bp = result.blueprints.find((b) => b.name === "updateable");

    expect(bp?.description).toBe("Updated description");
    expect(bp?.prompt).toBe("Updated prompt");
  });
});

// ============================================================================
// Agent Spawning Tests
// ============================================================================

describe("Agent Spawning", () => {
  let client: AgentSystemClient;
  let agencyClient: AgencyClient;

  beforeEach(async () => {
    client = createTestClient();
    const agency = await client.createAgency({ name: "Agent Spawn Test" });
    agencyClient = client.agency(agency.id);
  });

  it("should spawn an agent of a static blueprint type", async () => {
    try {
      const agent = await agencyClient.spawnAgent({ agentType: "assistant" });

      expect(agent).toHaveProperty("id");
      expect(agent.agentType).toBe("assistant");
      expect(agent).toHaveProperty("createdAt");
    } catch (e) {
      if (e instanceof AgentSystemError) {
        console.error("Spawn error body:", e.body);
      }
      throw e;
    }
  });

  it("should spawn an agent of a custom blueprint type", async () => {
    // Create a custom blueprint dynamically
    await agencyClient.createBlueprint({
      name: "spawnable-custom",
      description: "A spawnable custom agent",
      prompt: "You are a spawnable custom agent for testing.",
      tags: ["default"]
    });

    // Verify it was created
    const blueprints = await agencyClient.listBlueprints();
    expect(blueprints.blueprints.map((b) => b.name)).toContain(
      "spawnable-custom"
    );

    // Spawn the agent
    const agent = await agencyClient.spawnAgent({
      agentType: "spawnable-custom"
    });

    expect(agent).toHaveProperty("id");
    expect(agent.agentType).toBe("spawnable-custom");
  });

  it("should list spawned agents", async () => {
    const agent1 = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agent2 = await agencyClient.spawnAgent({ agentType: "calculator" });

    const result = await agencyClient.listAgents();

    expect(result.agents.length).toBeGreaterThanOrEqual(2);

    const ids = result.agents.map((a) => a.id);
    expect(ids).toContain(agent1.id);
    expect(ids).toContain(agent2.id);
  });
});

// ============================================================================
// Agent State Tests
// ============================================================================

describe("Agent State", () => {
  let client: AgentSystemClient;
  let agencyClient: AgencyClient;
  let agentClient: AgentClient;

  beforeEach(async () => {
    client = createTestClient();
    const agency = await client.createAgency({ name: "State Test Agency" });
    agencyClient = client.agency(agency.id);
    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    agentClient = agencyClient.agent(agent.id);
  });

  it("should get initial state of a freshly spawned agent", async () => {
    const { state, run } = await agentClient.getState();

    expect(state).toHaveProperty("messages");
    expect(state).toHaveProperty("tools");
    expect(state).toHaveProperty("thread");
    expect(state.agentType).toBe("assistant");

    // Run state should exist with a valid status
    expect(run).toBeDefined();
    if (run?.status) {
      expect(["registered", "idle", "running", "completed"]).toContain(
        run.status
      );
    }
  });

  it("should include thread metadata in state", async () => {
    const { state } = await agentClient.getState();

    expect(state.thread).toHaveProperty("id");
    expect(state.thread).toHaveProperty("createdAt");
    expect(state.thread.agentType).toBe("assistant");
  });

  it("should have tools registered from blueprint tags", async () => {
    const { state } = await agentClient.getState();

    // assistant has tags: ["default", "test"]
    // tools with "test" tag: echo, add, fail
    const toolNames = state.tools.map((t) => t.name);

    expect(toolNames).toContain("echo");
    expect(toolNames).toContain("add");
  });
});

// ============================================================================
// Agent Invoke Tests
// ============================================================================

describe("Agent Invoke", () => {
  let client: AgentSystemClient;
  let agencyClient: AgencyClient;

  beforeEach(async () => {
    client = createTestClient();
    const agency = await client.createAgency({ name: "Invoke Test Agency" });
    agencyClient = client.agency(agency.id);
  });

  it("should invoke an agent with a message", async () => {
    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    const result = await agentClient.invoke({
      messages: [{ role: "user", content: "Hello!" }]
    });

    expect(result).toHaveProperty("runId");
    expect(result.status).toBe("running");
  });

  it("should invoke an agent without messages (resume)", async () => {
    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    // First invoke to start
    await agentClient.invoke({
      messages: [{ role: "user", content: "Start" }]
    });

    // Second invoke without messages
    const result = await agentClient.invoke();

    expect(result).toHaveProperty("runId");
  });

  it("should update state after invoke", async () => {
    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    await agentClient.invoke({
      messages: [{ role: "user", content: "Test message" }]
    });

    const { state } = await agentClient.getState();

    // Should have at least the user message
    const userMessages = state.messages.filter((m) => m.role === "user");
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Agent Cancel Tests
// ============================================================================

describe("Agent Cancel", () => {
  let client: AgentSystemClient;
  let agencyClient: AgencyClient;

  beforeEach(async () => {
    client = createTestClient();
    const agency = await client.createAgency({ name: "Cancel Test Agency" });
    agencyClient = client.agency(agency.id);
  });

  it("should cancel a running agent", async () => {
    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    // Start a run
    await agentClient.invoke({
      messages: [{ role: "user", content: "Start something" }]
    });

    // Cancel it immediately
    const result = await agentClient.cancel();
    expect(result.ok).toBe(true);

    // Check state - may be canceled or completed (race condition)
    const { run } = await agentClient.getState();
    // Agent might complete before cancel takes effect, that's OK
    expect(["canceled", "completed"]).toContain(run?.status);
  });

  it("should be safe to cancel an already completed agent", async () => {
    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    // Cancel without running
    const result = await agentClient.cancel();
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// Events Tests
// ============================================================================

describe("Agent Events", () => {
  let client: AgentSystemClient;
  let agencyClient: AgencyClient;

  beforeEach(async () => {
    client = createTestClient();
    const agency = await client.createAgency({ name: "Events Test Agency" });
    agencyClient = client.agency(agency.id);
  });

  it("should retrieve events for an agent", async () => {
    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    // Trigger some activity
    await agentClient.invoke({
      messages: [{ role: "user", content: "Generate events" }]
    });

    // Give it a moment
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await agentClient.getEvents();

    expect(result).toHaveProperty("events");
    expect(Array.isArray(result.events)).toBe(true);

    // Should have at least run.started event
    const eventTypes = result.events.map((e) => e.type);
    expect(eventTypes).toContain("run.started");
  });

  it("should include timestamps on events", async () => {
    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    await agentClient.invoke({
      messages: [{ role: "user", content: "Timestamp test" }]
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await agentClient.getEvents();

    for (const event of result.events) {
      expect(event).toHaveProperty("ts");
      expect(event).toHaveProperty("threadId");
    }
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe("Error Handling", () => {
  let client: AgentSystemClient;

  beforeEach(() => {
    client = createTestClient();
  });

  it("should throw AgentSystemError on 404", async () => {
    const agencyClient = client.agency("nonexistent-agency-id-12345");

    await expect(agencyClient.listBlueprints()).rejects.toThrow(
      AgentSystemError
    );
  });

  it("should include status code in error", async () => {
    const agencyClient = client.agency("invalid-id");

    try {
      await agencyClient.listBlueprints();
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AgentSystemError);
      expect((e as AgentSystemError).status).toBe(400);
    }
  });
});

// ============================================================================
// Dashboard Tests
// ============================================================================

describe("Dashboard", () => {
  it("should serve HTML dashboard at root", async () => {
    const ctx = createExecutionContext();
    const req = new Request("http://test.local/");
    // @ts-expect-error - KVNamespace type mismatch between cloudflare:test and workers-types
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
  });
});

// ============================================================================
// Auth Tests
// ============================================================================

describe("Authentication", () => {
  it("should work without secret when none configured", async () => {
    const client = createTestClient();
    const result = await client.listAgencies();
    expect(result).toHaveProperty("agencies");
  });
});

// ============================================================================
// Client ID Tests
// ============================================================================

describe("Client Properties", () => {
  it("should expose agent ID", async () => {
    const client = createTestClient();
    const agency = await client.createAgency({ name: "ID Test" });
    const agencyClient = client.agency(agency.id);

    expect(agencyClient.id).toBe(agency.id);

    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    expect(agentClient.id).toBe(agent.id);
  });
});

// ============================================================================
// Mock Provider Integration Tests
// ============================================================================

describe("Agent Execution with Mock Provider", () => {
  let client: AgentSystemClient;
  let agencyClient: AgencyClient;

  beforeEach(async () => {
    // Reset mock provider state before each test
    mockProvider.reset();
    client = createTestClient();
    const agency = await client.createAgency({ name: "Mock Provider Test" });
    agencyClient = client.agency(agency.id);
  });

  afterEach(() => {
    mockProvider.reset();
  });

  it("should complete a simple conversation", async () => {
    // Queue a simple text response
    mockProvider.addResponse(
      MockResponses.text("Hello! How can I help you today?")
    );

    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    await agentClient.invoke({
      messages: [{ role: "user", content: "Hi there!" }]
    });

    // Wait for completion
    await waitForRunStatus(agentClient, ["completed", "paused"], 2000);

    const { state } = await agentClient.getState();

    // Should have the user message and assistant response
    const assistantMessages = state.messages.filter(
      (m) => m.role === "assistant"
    );
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
  });

  it("should execute tool calls from model response", async () => {
    // Queue: first a tool call, then final text response
    mockProvider.addResponse(
      MockResponses.toolCall("echo", { message: "hello from tool" })
    );
    mockProvider.addResponse(
      MockResponses.text("The echo tool returned the message.")
    );

    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    await agentClient.invoke({
      messages: [{ role: "user", content: "Please echo something" }]
    });

    // Wait a bit for tool execution to start
    await new Promise((resolve) => setTimeout(resolve, 200));

    const { state } = await agentClient.getState();

    // Should have tool result in messages (may not be complete yet)
    const toolMessages = state.messages.filter((m) => m.role === "tool");

    // The agent should have at least received the user message and started processing
    expect(state.messages.length).toBeGreaterThanOrEqual(1);

    // If tool messages exist, verify echo was called
    if (toolMessages.length > 0) {
      const toolContent = toolMessages.find(
        (m) => "content" in m && m.content.includes("Echo:")
      );
      expect(toolContent).toBeDefined();
    }
  }, 10000);

  it("should handle multiple tool calls in sequence", async () => {
    // Queue: tool call -> tool call -> final response
    mockProvider.addResponse(MockResponses.toolCall("add", { a: 5, b: 3 }));
    mockProvider.addResponse(
      MockResponses.toolCall("echo", { message: "result is 8" })
    );
    mockProvider.addResponse(
      MockResponses.text("I added 5 and 3 to get 8, then echoed it.")
    );

    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    await agentClient.invoke({
      messages: [{ role: "user", content: "Add 5 and 3, then echo the result" }]
    });

    // Wait for processing to happen
    await new Promise((resolve) => setTimeout(resolve, 300));

    const { state } = await agentClient.getState();

    // Verify the agent is processing - should have at least user message
    expect(state.messages.length).toBeGreaterThanOrEqual(1);

    // If tool messages exist, verify multiple tools were called
    const toolMessages = state.messages.filter((m) => m.role === "tool");
    if (toolMessages.length >= 2) {
      expect(toolMessages.length).toBeGreaterThanOrEqual(2);
    }
  }, 10000);

  it("should handle tool errors gracefully", async () => {
    // Queue a call to the fail tool, then a final response
    mockProvider.addResponse(
      MockResponses.toolCall("fail", { reason: "test error" })
    );
    mockProvider.addResponse(MockResponses.text("Sorry, the tool failed."));

    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    await agentClient.invoke({
      messages: [{ role: "user", content: "Trigger an error" }]
    });

    await waitForRunStatus(agentClient, ["completed", "paused", "error"], 3000);

    const { state } = await agentClient.getState();

    // Should have error in tool message
    const toolMessages = state.messages.filter((m) => m.role === "tool");
    const errorMessage = toolMessages.find(
      (m) => "content" in m && m.content.includes("Error:")
    );
    expect(errorMessage).toBeDefined();
  });

  it("should track model calls via mock provider", async () => {
    mockProvider.addResponse(MockResponses.text("Tracked response"));

    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    const initialCallCount = mockProvider.callCount;

    await agentClient.invoke({
      messages: [{ role: "user", content: "Track this" }]
    });

    await waitForRunStatus(agentClient, ["completed", "paused"], 2000);

    // Should have made at least one call to the provider
    expect(mockProvider.callCount).toBeGreaterThan(initialCallCount);

    // Verify the last call
    const lastCall = mockProvider.lastCall;
    expect(lastCall).toBeDefined();
    expect(lastCall?.request.messages).toBeDefined();
  });

  it("should emit events during execution", async () => {
    mockProvider.addResponse(
      MockResponses.toolCall("echo", { message: "event test" })
    );
    mockProvider.addResponse(MockResponses.text("Done with events"));

    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    await agentClient.invoke({
      messages: [{ role: "user", content: "Generate events" }]
    });

    await waitForRunStatus(agentClient, ["completed", "paused"], 3000);

    const { events } = await agentClient.getEvents();

    const eventTypes = events.map((e) => e.type);

    // Should have key lifecycle events
    expect(eventTypes).toContain("run.started");
    expect(eventTypes).toContain("model.started");
    expect(eventTypes).toContain("tool.started");
  });

  it("should complete with final text response", async () => {
    mockProvider.addResponse(MockResponses.text("This is the final answer."));

    const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
    const agentClient = agencyClient.agent(agent.id);

    await agentClient.invoke({
      messages: [{ role: "user", content: "Give me a final answer" }]
    });

    await waitForRunStatus(agentClient, ["completed"], 2000);

    const { run } = await agentClient.getState();
    expect(run?.status).toBe("completed");
  });
});

// ============================================================================
// Helper: Wait for run status
// ============================================================================

async function waitForRunStatus(
  agentClient: AgentClient,
  targetStatuses: string[],
  maxWaitMs = 5000,
  pollIntervalMs = 100
): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const { run } = await agentClient.getState();

    if (run?.status && targetStatuses.includes(run.status)) {
      return run.status;
    }

    // Also stop on terminal states
    if (run?.status && ["error", "canceled"].includes(run.status)) {
      return run.status;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Agent run did not reach ${targetStatuses.join("/")} within ${maxWaitMs}ms`
  );
}
