// Shared by the agent (server.ts) and the UI (client.tsx).

import type { BrowserLiveView, InternalHostInfo } from "agents/browser";

/** The Workers AI model the agent runs on. It takes images, so it sees screenshots. */
export const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

/** The agent's internal hostnames: sites only its browser can open. */
export const PREVIEW_HOST = "preview.internal";
export const FILES_HOST = "files.internal";
export const DOCS_HOST = "docs.internal";

/** computerd, the workspace daemon in the container, listens here. */
export const WORKSPACE_DAEMON_PORT = 8080;

/** What the UI's browser panel shows, from `BrowserAgent.browserState()`. */
export interface BrowserState {
  /** Live View URLs for the browser's tabs; null before the browser exists. */
  liveView: BrowserLiveView | null;
  /** Each internal hostname, with the target the model last assigned. */
  hosts: InternalHostInfo[];
}
