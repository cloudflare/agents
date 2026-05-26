import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { AssistantDirectory } from "./agent";
import type { McpToolDescriptor } from "./types";

// ── SharedMCPClient — child-side proxy for the directory's MCP ──────
//
// MCP state (server registry, OAuth tokens, live connections, tool
// caches) lives entirely on `AssistantDirectory`. This class lets a
// child expose those shared tools to its LLM as if they were local,
// while every actual invocation round-trips through one parent-DO
// RPC hop.
//
// Shape:
//   - `getAITools(timeoutMs?)` — snapshot the parent's current tools
//     and return them as an AI SDK `ToolSet`. Called once per turn
//     from `MyAssistant.beforeTurn`; the resulting tools are merged
//     into the turn via `TurnConfig.tools`.
//   - Each returned tool's `execute` RPCs `parent.callMcpTool(...)`
//     and translates the MCP-level `isError` result into a thrown
//     exception for Think's `afterToolCall` pipeline. Mirrors what
//     `MCPClientManager.getAITools()` does internally for a local
//     MCP client — same tool-key format, same error semantics — so
//     the LLM sees an identical surface whether MCP is local or
//     proxied.
//
// The parent stub is resolved lazily on first call and cached, same
// pattern as `SharedWorkspace`.

export class SharedMCPClient {
  #stubPromise?: Promise<DurableObjectStub<AssistantDirectory>>;

  constructor(
    private getParent: () => Promise<DurableObjectStub<AssistantDirectory>>
  ) {}

  private parent(): Promise<DurableObjectStub<AssistantDirectory>> {
    this.#stubPromise ??= this.getParent();
    return this.#stubPromise;
  }

  /**
   * Assemble a snapshot `ToolSet` of the currently-ready MCP tools.
   * The returned tools are safe to splice into Think's turn toolset
   * via `TurnConfig.tools`.
   */
  async getAITools(timeoutMs = 5_000): Promise<ToolSet> {
    const parent = await this.parent();
    const descriptors = (await parent.listMcpToolDescriptors(
      timeoutMs
    )) as McpToolDescriptor[];

    const entries: [string, ToolSet[string]][] = [];
    for (const descriptor of descriptors) {
      try {
        // Same key format MCPClientManager uses internally, so the
        // LLM's tool vocabulary matches the local-MCP case.
        const toolKey = `tool_${descriptor.serverId.replace(/-/g, "")}_${descriptor.name}`;
        const { serverId, name, inputSchema, outputSchema } = descriptor;
        const title =
          descriptor.title ??
          (descriptor.annotations as { title?: string } | undefined)?.title;

        entries.push([
          toolKey,
          {
            description: descriptor.description,
            title,
            inputSchema: inputSchema
              ? z.fromJSONSchema(
                  inputSchema as Parameters<typeof z.fromJSONSchema>[0]
                )
              : z.fromJSONSchema({ type: "object" }),
            outputSchema: outputSchema
              ? z.fromJSONSchema(
                  outputSchema as Parameters<typeof z.fromJSONSchema>[0]
                )
              : undefined,
            execute: async (args) => {
              const stub = await this.parent();
              const result = (await stub.callMcpTool(
                serverId,
                name,
                args as Record<string, unknown>
              )) as CallToolResult;
              if (result.isError) {
                const content = result.content as
                  | Array<{ type: string; text?: string }>
                  | undefined;
                const firstText = content?.[0];
                const message =
                  firstText?.type === "text" && firstText.text
                    ? firstText.text
                    : "Tool call failed";
                throw new Error(message);
              }
              return result;
            }
          }
        ]);
      } catch (err) {
        console.warn(
          `[SharedMCPClient] Skipping tool "${descriptor.name}" from "${descriptor.serverId}": ${err}`
        );
      }
    }

    return Object.fromEntries(entries);
  }
}
