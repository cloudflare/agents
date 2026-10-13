/**
 * The internal seam between {@link Browser} and the service that runs its
 * browser. A provider is the public, plain-data config a host passes
 * (`browserRun(env.BROWSER)`); its adapter is the code that does the work.
 * `Browser` keeps everything that doesn't depend on the provider — the
 * durable record, locks, restart detection, scopes, and activity touches —
 * and calls the adapter for the rest.
 *
 * Not exported from `agents/browser`: the provider set is closed, and this
 * interface may change as providers are added.
 */

import type { CdpConnection } from "../cdp-connection";
import type { BrowserLiveView, LiveViewMode } from "../live-view";
import type { SearchableCdpSpec } from "../spec";

/**
 * Thrown by {@link BrowserProviderAdapter.connect} when the session no longer
 * exists upstream (closed, expired, or reclaimed). `Browser` treats it as
 * "this browser is lost" and replaces it; any other error is passed on.
 */
export class BrowserSessionGoneError extends Error {
  constructor(
    readonly sessionId: string,
    options?: { cause?: unknown }
  ) {
    super(`Browser session gone: ${sessionId}`, options);
    this.name = "BrowserSessionGoneError";
  }
}

export interface BrowserProviderAdapter {
  /** Start a new browser session. */
  create(): Promise<{ sessionId: string }>;
  /**
   * Whether the session still exists. `true` means alive and `false` means
   * definitely gone. Throw when the answer is unknown (a 5xx, a network
   * error): `Browser` discards the browser on `false`, so a flaky probe must
   * never report it.
   */
  isAlive(sessionId: string): Promise<boolean>;
  /**
   * Open a CDP connection to the session. Throws
   * {@link BrowserSessionGoneError} when the session is gone.
   */
  connect(
    sessionId: string,
    options: { timeoutMs?: number; onActivity?: () => void }
  ): Promise<CdpConnection>;
  /** End the session. A session that's already gone counts as closed. */
  close(sessionId: string): Promise<void>;
  /** The Chrome DevTools Protocol description the session's browser serves. */
  spec(sessionId: string): Promise<SearchableCdpSpec>;
  /**
   * Live View URLs for the session's open tabs, or `undefined` when the
   * session is gone.
   */
  liveView(
    sessionId: string,
    mode?: LiveViewMode
  ): Promise<BrowserLiveView | undefined>;
  /**
   * How long the provider keeps an idle session before reclaiming it.
   * `Browser` refreshes the record's `updatedAt` at most every half window.
   * `undefined` when idle sessions are never reclaimed.
   */
  readonly keepAliveMs?: number;
}
