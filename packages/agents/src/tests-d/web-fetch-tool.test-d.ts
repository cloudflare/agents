import type { Tool, ToolSet } from "ai";
import type { ServerTool } from "@tanstack/ai";
import { expectTypeOf } from "vitest";
import {
  fetchWeb,
  type WebFetchPage,
  type WebFetchSource,
  type WebFetchToolOptions,
  type WebFetchToolOutput
} from "../web/fetch";
import { webFetchTool } from "../web/fetch/tools/ai-sdk";
import { webFetchTool as piWebFetchTool } from "../web/fetch/tools/pi";
import { webFetchTool as tanStackWebFetchTool } from "../web/fetch/tools/tanstack-ai";

declare const env: { AI: Ai };
declare const source: WebFetchSource;

// The binding carries the URL policy and limits.
webFetchTool({
  binding: env.AI,
  maxBytes: 1_000_000,
  maxRedirects: 3,
  userAgent: "my-agent",
  allowedHosts: ["*.example.com"],
  blockedHosts: ["internal.example.com"],
  allowPrivateHosts: true,
  pageChars: 10_000,
  timeoutMs: 5_000
});

// A source carries its own; the tool rejects them instead of ignoring them.
webFetchTool({ source, pageChars: 10_000, timeoutMs: 5_000 });
// @ts-expect-error binding or source, not both
webFetchTool({ source, binding: env.AI });
// @ts-expect-error maxBytes belongs to the source
webFetchTool({ source, maxBytes: 1 });
// @ts-expect-error allowedHosts belongs to the source
piWebFetchTool({ source, allowedHosts: ["example.com"] });
// @ts-expect-error userAgent belongs to the source
tanStackWebFetchTool({ source, userAgent: "x" });

// @ts-expect-error one of binding or source is required
webFetchTool({ pageChars: 10_000 });

expectTypeOf<{ source: WebFetchSource }>().toExtend<WebFetchToolOptions>();
expectTypeOf<{ binding: Ai }>().toExtend<WebFetchToolOptions>();
expectTypeOf<{ ai: Ai }>().not.toExtend<WebFetchToolOptions>();
expectTypeOf<{
  binding: Ai;
  source: WebFetchSource;
}>().not.toExtend<WebFetchToolOptions>();

// A plain AI SDK tool the host can put under any key, with a typed execute.
const aiSdkTool = webFetchTool({ source });
expectTypeOf(aiSdkTool).toExtend<
  Tool<
    { url: string; offset?: number; format?: "auto" | "raw" },
    WebFetchToolOutput
  >
>();
const tools: ToolSet = { web_fetch: aiSdkTool };
void tools;

// The TanStack AI adapter is a ServerTool.
expectTypeOf(tanStackWebFetchTool({ source })).toExtend<ServerTool>();

// fetchWeb returns the whole page; the tool's output is one window of it.
expectTypeOf(
  fetchWeb({ url: "https://example.com/" }, { binding: env.AI })
).resolves.toEqualTypeOf<WebFetchPage>();
expectTypeOf<WebFetchPage>().not.toHaveProperty("offset");
expectTypeOf<WebFetchToolOutput["nextOffset"]>().toEqualTypeOf<number | null>();
