import type { WebSearchSource } from "../websearch";
import { webSearchTool } from "../websearch/tools/ai-sdk";
import { webSearchTool as piWebSearchTool } from "../websearch/tools/pi";
import { webSearchTool as tanStackWebSearchTool } from "../websearch/tools/tanstack-ai";

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
