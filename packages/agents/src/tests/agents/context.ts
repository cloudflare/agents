import { Agent } from "../../index";
import {
  Context,
  AgentContextProvider,
  type ContextBlock
} from "../../experimental/memory/context";

/**
 * Test Agent for context memory tests (no predefined blocks)
 */
export class TestContextAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  context = new Context(new AgentContextProvider(this));

  getBlocks(): Record<string, ContextBlock> {
    return this.context.getBlocks();
  }

  getBlock(label: string): ContextBlock | null {
    return this.context.getBlock(label);
  }

  setBlock(
    label: string,
    content: string,
    options?: { description?: string; maxTokens?: number }
  ): ContextBlock {
    return this.context.setBlock(label, content, options);
  }

  appendToBlock(label: string, content: string): ContextBlock {
    return this.context.appendToBlock(label, content);
  }

  deleteBlock(label: string): void {
    this.context.deleteBlock(label);
  }

  clearBlocks(): void {
    this.context.clearBlocks();
  }

  contextToString(): string {
    return this.context.toString();
  }
}

/**
 * Test Agent with predefined blocks (including readonly)
 */
export class TestContextAgentWithDefaults extends Agent<
  Record<string, unknown>
> {
  observability = undefined;

  context = new Context(new AgentContextProvider(this), {
    blocks: [
      {
        label: "soul",
        description: "Agent personality",
        defaultContent: "You are a helpful assistant.",
        readonly: true
      },
      {
        label: "todos",
        description: "User's todo list",
        maxTokens: 100
      },
      {
        label: "preferences",
        description: "Learned user preferences",
        defaultContent: "- prefers concise responses"
      }
    ]
  });

  getBlocks(): Record<string, ContextBlock> {
    return this.context.getBlocks();
  }

  getBlock(label: string): ContextBlock | null {
    return this.context.getBlock(label);
  }

  setBlock(
    label: string,
    content: string,
    options?: { description?: string; maxTokens?: number }
  ): ContextBlock {
    return this.context.setBlock(label, content, options);
  }

  appendToBlock(label: string, content: string): ContextBlock {
    return this.context.appendToBlock(label, content);
  }

  deleteBlock(label: string): void {
    this.context.deleteBlock(label);
  }

  clearBlocks(): void {
    this.context.clearBlocks();
  }

  contextToString(): string {
    return this.context.toString();
  }
}
