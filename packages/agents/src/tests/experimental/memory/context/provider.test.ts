import { env } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import type { Env } from "../../../worker";
import { getAgentByName } from "../../../..";
import type { ContextBlock } from "../../../../experimental/memory/context";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/**
 * Typed stub interface for TestContextAgent
 */
interface ContextAgentStub {
  getBlocks(): Promise<Record<string, ContextBlock>>;
  getBlock(label: string): Promise<ContextBlock | null>;
  setBlock(
    label: string,
    content: string,
    options?: { description?: string; maxTokens?: number }
  ): Promise<ContextBlock>;
  appendToBlock(label: string, content: string): Promise<ContextBlock>;
  deleteBlock(label: string): Promise<void>;
  clearBlocks(): Promise<void>;
  contextToString(): Promise<string>;
}

/** Helper to get a typed agent stub (no predefined blocks) */
async function getContextAgent(name: string): Promise<ContextAgentStub> {
  return getAgentByName(
    env.TestContextAgent,
    name
  ) as unknown as Promise<ContextAgentStub>;
}

/** Helper to get a typed agent stub (with predefined blocks) */
async function getContextAgentWithDefaults(
  name: string
): Promise<ContextAgentStub> {
  return getAgentByName(
    env.TestContextAgentWithDefaults,
    name
  ) as unknown as Promise<ContextAgentStub>;
}

describe("AgentContextProvider", () => {
  let instanceName: string;

  beforeEach(() => {
    instanceName = `context-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  describe("basic operations", () => {
    it("should start with no blocks", async () => {
      const agent = await getContextAgent(instanceName);
      const blocks = await agent.getBlocks();
      expect(blocks).toEqual({});
    });

    it("should set and retrieve a block", async () => {
      const agent = await getContextAgent(instanceName);

      const result = await agent.setBlock("greeting", "Hello, world!", {
        description: "A greeting message"
      });

      expect(result.label).toBe("greeting");
      expect(result.content).toBe("Hello, world!");
      expect(result.description).toBe("A greeting message");
      expect(result.tokens).toBeGreaterThan(0);

      const retrieved = await agent.getBlock("greeting");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.content).toBe("Hello, world!");
    });

    it("should set multiple blocks and getBlocks", async () => {
      const agent = await getContextAgent(instanceName);

      await agent.setBlock("block-a", "Content A");
      await agent.setBlock("block-b", "Content B");
      await agent.setBlock("block-c", "Content C");

      const blocks = await agent.getBlocks();
      expect(Object.keys(blocks)).toHaveLength(3);
      expect(blocks["block-a"].content).toBe("Content A");
      expect(blocks["block-b"].content).toBe("Content B");
      expect(blocks["block-c"].content).toBe("Content C");
    });

    it("should overwrite (upsert) a block", async () => {
      const agent = await getContextAgent(instanceName);

      await agent.setBlock("data", "original content");
      await agent.setBlock("data", "updated content");

      const block = await agent.getBlock("data");
      expect(block!.content).toBe("updated content");
    });

    it("should return null for non-existent block", async () => {
      const agent = await getContextAgent(instanceName);
      const block = await agent.getBlock("does-not-exist");
      expect(block).toBeNull();
    });
  });

  describe("delete and clear", () => {
    it("should delete a block", async () => {
      const agent = await getContextAgent(instanceName);

      await agent.setBlock("temp", "temporary data");
      expect(await agent.getBlock("temp")).not.toBeNull();

      await agent.deleteBlock("temp");
      expect(await agent.getBlock("temp")).toBeNull();
    });

    it("should clear all blocks", async () => {
      const agent = await getContextAgent(instanceName);

      await agent.setBlock("a", "1");
      await agent.setBlock("b", "2");
      await agent.setBlock("c", "3");

      await agent.clearBlocks();
      const blocks = await agent.getBlocks();
      expect(blocks).toEqual({});
    });
  });

  describe("append", () => {
    it("should append to a block", async () => {
      const agent = await getContextAgent(instanceName);

      await agent.setBlock("notes", "first line");
      const result = await agent.appendToBlock("notes", "\nsecond line");

      expect(result.content).toBe("first line\nsecond line");
    });

    it("should throw when appending to non-existent block", async () => {
      const agent = await getContextAgent(instanceName);

      try {
        await agent.appendToBlock("ghost", "data");
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(String(e)).toContain('Block "ghost" does not exist');
      }
    });
  });

  describe("maxTokens enforcement", () => {
    it("should enforce maxTokens on setBlock", async () => {
      const agent = await getContextAgent(instanceName);

      // Set a block with a very small maxTokens
      await agent.setBlock("limited", "ok", { maxTokens: 5 });

      // Try to set content that exceeds the limit
      try {
        await agent.setBlock("limited", "a ".repeat(100));
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(String(e)).toContain("exceeds maxTokens");
      }
    });

    it("should enforce maxTokens on appendToBlock", async () => {
      const agent = await getContextAgent(instanceName);

      await agent.setBlock("limited", "short", { maxTokens: 5 });

      // Append content that would push over the limit
      try {
        await agent.appendToBlock("limited", " ".concat("a ".repeat(100)));
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(String(e)).toContain("exceeds maxTokens");
      }
    });

    it("should allow content within maxTokens", async () => {
      const agent = await getContextAgent(instanceName);

      // Set with generous token limit
      const result = await agent.setBlock("limited", "hello", {
        maxTokens: 1000
      });
      expect(result.content).toBe("hello");
    });
  });

  describe("predefined blocks with defaults", () => {
    it("should initialize predefined blocks on first access", async () => {
      const agent = await getContextAgentWithDefaults(instanceName);

      const blocks = await agent.getBlocks();
      expect(blocks["soul"]).toBeDefined();
      expect(blocks["soul"].content).toBe("You are a helpful assistant.");
      expect(blocks["soul"].description).toBe("Agent personality");
      expect(blocks["soul"].readonly).toBe(true);

      expect(blocks["todos"]).toBeDefined();
      expect(blocks["todos"].content).toBe("");

      expect(blocks["preferences"]).toBeDefined();
      expect(blocks["preferences"].content).toBe("- prefers concise responses");
    });

    it("should preserve existing content on re-initialization", async () => {
      const agent = await getContextAgentWithDefaults(instanceName);

      // First access initializes defaults
      await agent.getBlocks();

      // Modify a writable block
      await agent.setBlock("preferences", "custom preferences");

      // Clear and re-init (simulating re-initialization)
      // clearBlocks resets defaultsInitialized, next access re-inits
      await agent.clearBlocks();
      const blocks = await agent.getBlocks();

      // Defaults are re-initialized (since clear removed everything)
      expect(blocks["soul"].content).toBe("You are a helpful assistant.");
      expect(blocks["preferences"].content).toBe("- prefers concise responses");
    });
  });

  describe("readonly blocks", () => {
    it("should reject setBlock on readonly blocks", async () => {
      const agent = await getContextAgentWithDefaults(instanceName);

      // Initialize defaults (soul is readonly)
      await agent.getBlocks();

      try {
        await agent.setBlock("soul", "I am a pirate now!");
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(String(e)).toContain('Block "soul" is readonly');
      }
    });

    it("should reject appendToBlock on readonly blocks", async () => {
      const agent = await getContextAgentWithDefaults(instanceName);

      // Initialize defaults
      await agent.getBlocks();

      try {
        await agent.appendToBlock("soul", " Also a pirate.");
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(String(e)).toContain('Block "soul" is readonly');
      }
    });
  });

  describe("toString", () => {
    it("should render blocks as formatted text", async () => {
      const agent = await getContextAgent(instanceName);

      await agent.setBlock("greeting", "Hello!", {
        description: "A greeting"
      });
      await agent.setBlock("notes", "Some notes");

      const result = await agent.contextToString();
      expect(result).toContain('<context_block label="greeting"');
      expect(result).toContain('description="A greeting"');
      expect(result).toContain("Hello!");
      expect(result).toContain('<context_block label="notes"');
      expect(result).toContain("Some notes");
    });

    it("should include readonly attribute for readonly blocks", async () => {
      const agent = await getContextAgentWithDefaults(instanceName);

      const result = await agent.contextToString();
      expect(result).toContain('readonly="true"');
      expect(result).toContain("You are a helpful assistant.");
    });

    it("should return empty string when no blocks exist", async () => {
      const agent = await getContextAgent(instanceName);
      const result = await agent.contextToString();
      expect(result).toBe("");
    });
  });

  describe("persistence", () => {
    it("should persist across agent instance lookups", async () => {
      const name = `persist-${Date.now()}`;

      // First lookup — set a block
      const agent1 = await getContextAgent(name);
      await agent1.setBlock("data", "persistent value", {
        description: "Persisted block"
      });

      // Second lookup — same name, should see the block
      const agent2 = await getContextAgent(name);
      const block = await agent2.getBlock("data");

      expect(block).not.toBeNull();
      expect(block!.content).toBe("persistent value");
      expect(block!.description).toBe("Persisted block");
    });
  });
});
