/**
 * Live View vocabulary shared by every host-side surface that mints links:
 * the connector's `getLiveViewUrl` tool and the `BrowserSessions`
 * capability's `liveView()`. Live View URLs are bearer credentials — mint
 * them fresh from a target listing when a human is about to view, and never
 * persist them.
 */

import type { BrowserTargetInfo } from "./browser-run";

/**
 * Live View rendering mode (the `mode` query param the hosted UI at
 * `live.browser.run` understands):
 *
 * - `"tab"` — a standalone, interactive page view (best for handing control
 *   to a human).
 * - `"devtools"` — the full DevTools inspector panel (Elements, Console,
 *   Network, …).
 *
 * Omit it to use whatever mode the binding's `devtoolsFrontendUrl` defaults
 * to.
 */
export type LiveViewMode = "tab" | "devtools";

/** A single tab's Live View URL. */
export interface BrowserLiveViewUrl {
  /** Open this in a browser to watch/control the tab in real time. */
  url: string;
  /** CDP target (tab) id the URL points at. */
  targetId: string;
  /** Milliseconds the URL stays valid from when it was generated (~5 min). */
  expiresInMs: number;
}

export interface BrowserLiveViewTarget {
  targetId: string;
  /** Embeddable Live View URL (the `devtoolsFrontendUrl`) for this tab. */
  url: string;
  /** The page the tab is currently showing (e.g. `https://example.com`). */
  pageUrl?: string;
  title?: string;
  type?: string;
}

/** Live View URLs for every tab in a session. */
export interface BrowserLiveView {
  sessionId: string;
  targets: BrowserLiveViewTarget[];
  /** Milliseconds the URLs stay valid from when they were generated (~5 min). */
  expiresInMs: number;
}

/**
 * Browser Run mints `devtoolsFrontendUrl`s (the Live View links) that are
 * valid for ~5 minutes. We surface the window so callers can decide how long
 * a shared link is good for before re-listing targets.
 */
export const LIVE_VIEW_URL_TTL_MS = 5 * 60 * 1000;

/**
 * Rewrite the hosted Live View UI's `mode` query param (`tab` | `devtools`).
 * The raw `devtoolsFrontendUrl` is returned unchanged when no mode is asked
 * for or the URL can't be parsed.
 */
export function applyLiveViewMode(rawUrl: string, mode?: LiveViewMode): string {
  if (!mode) return rawUrl;
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("mode", mode === "devtools" ? "devtools" : "tab");
    return url.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Project a fresh target listing into Live View links — one per tab that has
 * a `devtoolsFrontendUrl`. Pure; the caller supplies just-listed targets.
 */
export function createLiveView(
  sessionId: string,
  targets: BrowserTargetInfo[],
  mode?: LiveViewMode
): BrowserLiveView {
  return {
    sessionId,
    targets: targets
      .filter((target) => target.devtoolsFrontendUrl)
      .map((target) => ({
        targetId: target.id,
        url: applyLiveViewMode(target.devtoolsFrontendUrl!, mode),
        pageUrl: target.url,
        title: target.title,
        type: target.type
      })),
    expiresInMs: LIVE_VIEW_URL_TTL_MS
  };
}
