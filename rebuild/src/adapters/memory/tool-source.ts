import { NotFoundError } from "../../kernel/errors.js";
import type { ExternalToolSource } from "../../ports/tool-source.js";
import type { ToolDescriptor } from "../../ports/model.js";

export interface MemoryTool {
  descriptor: ToolDescriptor;
  handler: (input: unknown, signal?: AbortSignal) => Promise<unknown>;
}

export function createMemoryToolSource(id: string, tools: Record<string, MemoryTool>): ExternalToolSource {
  return {
    id,
    async ready(): Promise<void> {
      // Static map is always ready.
    },
    async listTools(): Promise<ToolDescriptor[]> {
      return Object.values(tools).map((t) => t.descriptor);
    },
    async callTool(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
      const tool = tools[name];
      if (!tool) throw new NotFoundError(`Unknown tool: ${name}`);
      return tool.handler(input, signal);
    },
  };
}
