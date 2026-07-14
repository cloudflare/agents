import { Agent, routeAgentRequest, unstable_callable as callable } from "agents";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// 1. A large MCP catalog (>300 tools) with complex nested input+output schemas.
//    Exposed through a Durable Object binding as an McpAgent — exactly the
//    "Durable Object MCP binding" shape described in issue #1938.
// ---------------------------------------------------------------------------

const TOOL_COUNT = 313; // matches the "313 tools" reported in the issue

// Deliberately complex nested schemas (objects, arrays, unions, enums, records)
// so each tool costs real work to compile through z.fromJSONSchema.
function complexInputShape() {
  return {
    filter: z.object({
      field: z.string(),
      op: z.enum(["eq", "neq", "gt", "lt", "in", "contains"]),
      value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    }),
    pagination: z
      .object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20)
      })
      .optional(),
    options: z
      .object({
        include: z
          .array(z.enum(["meta", "audit", "children", "history"]))
          .optional(),
        nested: z.object({
          a: z.object({ b: z.object({ c: z.array(z.string()) }) }),
          tags: z.record(z.string(), z.string()).optional()
        }),
        mode: z.union([
          z.literal("fast"),
          z.literal("accurate"),
          z.object({ custom: z.number() })
        ])
      })
      .optional()
  };
}

function complexOutputShape() {
  return {
    items: z.array(
      z.object({
        id: z.string(),
        attributes: z.record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean()])
        ),
        children: z.array(z.object({ id: z.string(), score: z.number() })),
        status: z.enum(["ok", "pending", "error"])
      })
    ),
    page: z.object({ next: z.string().optional(), total: z.number() })
  };
}

export class McpCatalog extends McpAgent<Env> {
  server = new McpServer({ name: "large-catalog", version: "1.0.0" });

  async init() {
    for (let i = 0; i < TOOL_COUNT; i++) {
      this.server.registerTool(
        `resource_op_${i}`,
        {
          description: `Complex catalog operation #${i} with nested input and output schemas.`,
          inputSchema: complexInputShape(),
          outputSchema: complexOutputShape()
        },
        async () => ({
          content: [{ type: "text", text: "ok" }],
          structuredContent: { items: [], page: { total: 0 } }
        })
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. An agent that registers the catalog for Code Mode and reproduces exactly
//    what Think._runInferenceLoop does at the top of every turn:
//
//      let tools = { ...otherTools, ...(this.mcp?.getAITools?.() ?? {}) };
//      // ...only AFTER this does beforeTurn narrow `activeTools`.
//
//    (packages/think/src/think.ts, _runInferenceLoop, ~line 5182)
//
//    getAITools() compiles a Zod schema for EVERY MCP tool's input AND output
//    via z.fromJSONSchema (packages/agents/src/mcp/client.ts:1839-1848). This
//    happens even though the direct MCP tools are excluded from the model via
//    activeTools — the exclusion is applied far too late to save the work.
// ---------------------------------------------------------------------------

type ReproMeasurement = {
  mcpToolCount: number;
  // What one "normal turn" pays: getAITools() called once per turn.
  turn: {
    getAIToolsMs: number;
    toolsMaterialized: number;
    zodSchemasCompiled: number; // input + output schemas materialized
    inputSchemasAreZod: boolean; // proof each schema is a compiled Zod object
    outputSchemasAreZod: boolean;
  };
  // Think applies activeTools AFTER the toolset is built. We reproduce that
  // filter to show the model would receive ZERO MCP tools — yet every schema
  // above was already compiled.
  mcpToolsExposedToModel: number;
  activeToolsWouldBe: string[];
  // No per-catalog caching: a second turn recompiles the whole catalog again.
  secondTurnGetAIToolsMs: number;
  note: string;
};

export class ReproAgent extends Agent<Env> {
  @callable()
  async runRepro(): Promise<ReproMeasurement> {
    // Register the large MCP catalog through the Durable Object binding.
    // Intended to be consumed ONLY through Code Mode.
    await this.addMcpServer("catalog", this.env.McpCatalog);
    await this.mcp.waitForConnections?.({ timeout: 15_000 });

    // ---- what a single normal turn pays (think.ts:5182) --------------------
    const t0 = Date.now();
    const mcpTools = this.mcp.getAITools();
    const getAIToolsMs = Date.now() - t0;

    const entries = Object.entries(mcpTools);
    let zodSchemasCompiled = 0;
    let inputSchemasAreZod = entries.length > 0;
    let outputSchemasAreZod = entries.length > 0;
    for (const [, t] of entries) {
      const tool = t as { inputSchema?: unknown; outputSchema?: unknown };
      if (tool.inputSchema) {
        zodSchemasCompiled++;
        if (!isZodSchema(tool.inputSchema)) inputSchemasAreZod = false;
      }
      if (tool.outputSchema) {
        zodSchemasCompiled++;
        if (!isZodSchema(tool.outputSchema)) outputSchemasAreZod = false;
      }
    }

    // ---- the activeTools filter Think applies AFTER building the toolset ----
    // (Code Mode agents exclude the direct MCP tools from the model.)
    const allToolNames = Object.keys(mcpTools);
    const activeTools = allToolNames.filter((n) => !n.startsWith("tool_"));
    const mcpToolsExposedToModel = activeTools.filter((n) =>
      n.startsWith("tool_")
    ).length;

    // ---- a second turn: schemas are recompiled from scratch (no cache) ------
    const t1 = Date.now();
    this.mcp.getAITools();
    const secondTurnGetAIToolsMs = Date.now() - t1;

    return {
      mcpToolCount: entries.length,
      turn: {
        getAIToolsMs,
        toolsMaterialized: entries.length,
        zodSchemasCompiled,
        inputSchemasAreZod,
        outputSchemasAreZod
      },
      mcpToolsExposedToModel,
      activeToolsWouldBe: activeTools.slice(0, 5),
      secondTurnGetAIToolsMs,
      note:
        "A normal turn calls mcp.getAITools() unconditionally (think.ts _runInferenceLoop, " +
        "~line 5182) BEFORE beforeTurn can narrow activeTools. It compiles a Zod schema for " +
        "every MCP tool's input AND output (client.ts getAITools -> z.fromJSONSchema). Even " +
        "with 0 MCP tools exposed to the model, all schemas are materialized on every turn, " +
        "with no per-catalog caching."
    };
  }
}

function isZodSchema(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    // zod v4 schemas expose a `_zod` internals marker (and/or a `def`).
    ("_zod" in (v as Record<string, unknown>) ||
      "_def" in (v as Record<string, unknown>) ||
      "def" in (v as Record<string, unknown>))
  );
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
