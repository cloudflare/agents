import type { Tool, ToolSet } from "ai";
import type { ServerTool } from "@tanstack/ai";
import { expectTypeOf } from "vitest";
import type { WebSearchSource, WebSearchToolOutput } from "../web/search";
import { webSearchTool } from "../web/search/tools/ai-sdk";
import { webSearchTool as piWebSearchTool } from "../web/search/tools/pi";
import { webSearchTool as tanStackWebSearchTool } from "../web/search/tools/tanstack-ai";

declare const env: { AI: Ai };
declare const source: WebSearchSource;

// The binding carries the gateway, provider, and billing options.
webSearchTool({
  binding: env.AI,
  gateway: "prod",
  provider: "exa",
  byokAlias: "team"
});

// A source carries its own; the tool rejects them instead of ignoring them.
webSearchTool({ source, limit: 3 });
// @ts-expect-error provider belongs to the source
webSearchTool({ source, provider: "exa" });
// @ts-expect-error gateway belongs to the source
piWebSearchTool({ source, gateway: "prod" });
// @ts-expect-error byokAlias belongs to the source
tanStackWebSearchTool({ source, byokAlias: "team" });
// @ts-expect-error binding or source, not both
webSearchTool({ source, binding: env.AI });

// @ts-expect-error one of binding or source is required
webSearchTool({ limit: 3 });

// A plain AI SDK tool the host can put under any key, with a typed execute.
const aiSdkTool = webSearchTool({ source });
expectTypeOf(aiSdkTool).toExtend<
  Tool<{ query: string; limit?: number }, WebSearchToolOutput>
>();
const tools: ToolSet = { web_search: aiSdkTool };
void tools;

// The TanStack AI adapter is a ServerTool.
expectTypeOf(tanStackWebSearchTool({ source })).toExtend<ServerTool>();
