import type { ToolSet } from "ai";
import type { JSONSchema7 } from "json-schema";
import type { JsonSchemaToolDescriptors } from "../json-schema-types";
import type { ToolDescriptors } from "../tool-types";
import { CodemodeConnector } from "./base";

/**
 * Connector backed by an existing AI SDK ToolSet or codemode ToolDescriptors.
 *
 * Subclass and override `name()` and `tools()`.
 */
export abstract class ToolsetConnector<
  Env = unknown,
  Props = unknown
> extends CodemodeConnector<Env, Props> {
  protected abstract tools():
    | ToolDescriptors
    | ToolSet
    | Promise<ToolDescriptors | ToolSet>;

  protected override async loadDescriptors(): Promise<JsonSchemaToolDescriptors> {
    const allTools = await this.tools();
    const descriptors: JsonSchemaToolDescriptors = {};
    for (const [name, tool] of Object.entries(allTools)) {
      if (!tool || typeof tool !== "object") continue;
      const t = tool as {
        description?: string;
        parameters?: unknown;
      };
      descriptors[name] = {
        description: t.description,
        inputSchema: (t.parameters ?? {
          type: "object"
        }) as JSONSchema7
      };
    }
    return descriptors;
  }

  async executeTool(method: string, args: unknown): Promise<unknown> {
    const allTools = await this.tools();
    const tool = (allTools as Record<string, unknown>)[method];
    if (!tool || typeof tool !== "object") {
      throw new Error(`Tool "${method}" not found on ${this.name()}`);
    }
    const execute = (tool as { execute?: (input: unknown) => Promise<unknown> })
      .execute;
    if (!execute) {
      throw new Error(`Tool "${method}" has no execute function`);
    }
    return execute(args);
  }
}
