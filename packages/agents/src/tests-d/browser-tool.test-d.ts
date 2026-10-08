import type { Tool, ToolSet } from "ai";
import type { ServerTool } from "@tanstack/ai";
import { expectTypeOf } from "vitest";
import {
  browserTool,
  type BrowserTool,
  type BrowserToolOutput
} from "../browser/tools/ai-sdk";
import { Browser, browserRun } from "../browser";
import { browserTool as tanStackBrowserTool } from "../browser/tools/tanstack-ai";

declare const env: { BROWSER: Fetcher; LOADER: WorkerLoader };

const tool = browserTool({
  browser: new Browser({ provider: browserRun(env.BROWSER) }),
  loader: env.LOADER
});

// A plain AI SDK tool the host can put under any key.
expectTypeOf(tool).toExtend<Tool<{ code: string }, BrowserToolOutput>>();
const tools: ToolSet = { browser: tool };
void tools;

// `execute` is always present and typed — no casts needed to call it.
expectTypeOf(tool.execute).returns.resolves.toEqualTypeOf<BrowserToolOutput>();
expectTypeOf<BrowserToolOutput["restarted"]>().toEqualTypeOf<
  true | undefined
>();
expectTypeOf<BrowserTool["toModelOutput"]>().toBeFunction();

// The tool takes a browser object, not a session name.
browserTool({
  // @ts-expect-error pass a Browser, not a name
  browser: "research",
  loader: env.LOADER
});

// The TanStack AI adapter: a ServerTool named `browser` unless the host picks.
const tanStackTool = tanStackBrowserTool({
  browser: new Browser({ provider: browserRun(env.BROWSER) }),
  loader: env.LOADER
});
expectTypeOf(tanStackTool).toExtend<ServerTool>();
expectTypeOf(tanStackTool.name).toEqualTypeOf<"browser">();
expectTypeOf(
  tanStackBrowserTool({
    browser: new Browser({ provider: browserRun(env.BROWSER) }),
    loader: env.LOADER,
    name: "web"
  }).name
).toEqualTypeOf<"web">();
