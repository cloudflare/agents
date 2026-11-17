/**
 * Apps can compile with `exactOptionalPropertyTypes`, which treats an
 * optional property (`x?: T`) and one that may be `undefined`
 * (`x: T | undefined`) as different types. The SDK's own source doesn't
 * compile with that flag, so these checks import the built package (`dist`)
 * the way an app does.
 */
import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import type { AgentMcpOAuthProvider } from "agents";
import { Browser, browserRun } from "agents/browser";
import type { BrowserSource } from "agents/browser";
import { browserTool as aiSdkBrowserTool } from "agents/browser/ai-sdk";
import { browserTool as piBrowserTool } from "agents/browser/pi";
import { browserTool as tanStackBrowserTool } from "agents/browser/tanstack-ai";
import { DurableObjectOAuthClientProvider } from "agents/mcp/do-oauth-client-provider";

declare const env: {
  BROWSER: Fetcher;
  LOADER: WorkerLoader;
  storage: DurableObjectStorage;
};

// A DurableObjectOAuthClientProvider, or a subclass, is an OAuth provider.
const provider = new DurableObjectOAuthClientProvider(
  env.storage,
  "client",
  "https://example.com/callback"
);
class CustomOAuthProvider extends DurableObjectOAuthClientProvider {}
const customProvider = new CustomOAuthProvider(
  env.storage,
  "client",
  "https://example.com/callback"
);

export const mcpProvider: OAuthClientProvider = provider;
export const agentProvider: AgentMcpOAuthProvider = provider;
export const customAgentProvider: AgentMcpOAuthProvider = customProvider;

// A Browser is a BrowserSource, so every browserTool accepts it.
const browser = new Browser({ provider: browserRun(env.BROWSER) });

export const source: BrowserSource = browser;
export const aiSdkTool = aiSdkBrowserTool({ browser, loader: env.LOADER });
export const piTool = piBrowserTool({ browser, loader: env.LOADER });
export const tanStackTool = tanStackBrowserTool({
  browser,
  loader: env.LOADER
});
