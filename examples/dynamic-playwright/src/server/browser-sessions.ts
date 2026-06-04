import type { BrowserEnv, BrowserTarget, LiveViewTarget } from "./types";

const KEEP_ALIVE_MS = 600_000;

export async function createBrowserSession(env: BrowserEnv): Promise<string> {
  const response = await env.BROWSER.fetch(
    `http://fake.host/v1/acquire?keep_alive=${KEEP_ALIVE_MS}`
  );
  if (!response.ok) {
    throw new Error(`Failed to acquire browser session: ${response.status}`);
  }
  const data = (await response.json()) as { sessionId?: string };
  if (!data.sessionId)
    throw new Error("Acquire response did not include sessionId");
  return data.sessionId;
}

export async function listLiveViewTargets(
  env: BrowserEnv,
  sessionId: string
): Promise<LiveViewTarget[]> {
  const targets = (await listTargets(env, sessionId))
    .filter(hasLiveViewUrl)
    .map((item) => ({
      id: item.id,
      url: item.url,
      title: item.title,
      devtoolsFrontendUrl: normalizeLiveViewUrl(item.devtoolsFrontendUrl)
    }))
    .sort(
      (left, right) =>
        Number(isBlankTarget(left)) - Number(isBlankTarget(right))
    );
  const navigatedTargets = targets.filter((target) => !isBlankTarget(target));
  return navigatedTargets.length
    ? navigatedTargets.slice(0, 1)
    : targets.slice(0, 1);
}

export async function closeBrowserSession(
  env: BrowserEnv,
  sessionId: string
): Promise<void> {
  const response = await env.BROWSER.fetch(
    `http://fake.host/v1/devtools/browser/${sessionId}`,
    { method: "DELETE" }
  );

  if (!response.ok) {
    throw new Error(`Failed to close browser session: ${response.status}`);
  }
}

async function listTargets(
  env: BrowserEnv,
  sessionId: string
): Promise<BrowserTarget[]> {
  const response = await env.BROWSER.fetch(
    `http://fake.host/v1/devtools/browser/${sessionId}/json/list`
  );
  if (!response.ok) {
    throw new Error(`Failed to list browser targets: ${response.status}`);
  }

  const targets = await response.json<unknown>();
  if (!Array.isArray(targets)) {
    throw new Error("Browser target list response was not an array");
  }

  return targets.filter(isBrowserTarget);
}

function isBrowserTarget(value: unknown): value is BrowserTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target.id === "string" &&
    typeof target.type === "string" &&
    typeof target.url === "string" &&
    typeof target.title === "string"
  );
}

function hasLiveViewUrl(
  target: BrowserTarget
): target is BrowserTarget & { devtoolsFrontendUrl: string } {
  return (
    target.type === "page" && typeof target.devtoolsFrontendUrl === "string"
  );
}

function normalizeLiveViewUrl(devtoolsFrontendUrl: string): string {
  const url = new URL(devtoolsFrontendUrl);
  url.pathname = "/ui/view";
  url.searchParams.set("mode", "tab");
  return url.toString();
}

function isBlankTarget(target: LiveViewTarget): boolean {
  return target.url === "about:blank";
}
