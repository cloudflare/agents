/**
 * The Browser Run provider: `browserRun(env.BROWSER, options)` and the
 * adapter that runs a {@link Browser}'s browser on Cloudflare Browser Run.
 */

import {
  acquireBrowserSession,
  type BrowserBinding,
  type BrowserSessionGuardrails,
  closeBrowserSession,
  connectBrowserSession,
  isMissingBrowserSession,
  listBrowserTargets
} from "../browser-run";
import { createLiveView } from "../live-view";
import { loadCdpSpec } from "../spec";
import {
  BrowserSessionGoneError,
  type BrowserProviderAdapter
} from "./provider-adapter";

/**
 * Default `keep_alive` for a `Browser` on Browser Run: 10 minutes. Long
 * enough to survive quiet spells between agent turns, while an abandoned
 * browser bills for at most 10 idle minutes (a whole day of Workers Free
 * browser time).
 */
export const BROWSER_SESSION_KEEP_ALIVE_DEFAULT_MS = 600_000;

/**
 * Browser Run's `keep_alive` maximum: 20 minutes. Browser Run rejects
 * anything longer.
 */
export const BROWSER_SESSION_KEEP_ALIVE_MAX_MS = 1_200_000;

/**
 * Browser Run settings applied every time a browser is created — including
 * when a lost browser is replaced — so options like guardrails survive a
 * restart.
 */
export interface BrowserRunOptions {
  /**
   * Platform `keep_alive` in milliseconds: how long an idle browser lives.
   * Defaults to {@link BROWSER_SESSION_KEEP_ALIVE_DEFAULT_MS} (10 minutes).
   * Browser Run accepts up to {@link BROWSER_SESSION_KEEP_ALIVE_MAX_MS}
   * (20 minutes).
   */
  keepAliveMs?: number;
  /** Opt into Browser Run session recording (rrweb capture). */
  recording?: boolean;
  /** Hostname guardrails, fixed at launch for every connection. */
  guardrails?: BrowserSessionGuardrails;
}

/** A {@link Browser} provider backed by Cloudflare Browser Run. */
export interface BrowserRunProvider {
  readonly kind: "browser-run";
  readonly binding: BrowserBinding;
  readonly options: BrowserRunOptions;
}

/**
 * Run the browser on Cloudflare Browser Run.
 *
 * @example
 * ```ts
 * new Browser({ provider: browserRun(env.BROWSER, { recording: true }) });
 * ```
 */
export function browserRun(
  binding: BrowserBinding,
  options: BrowserRunOptions = {}
): BrowserRunProvider {
  return { kind: "browser-run", binding, options };
}

/** The code behind {@link browserRun}. */
export function browserRunAdapter(
  provider: BrowserRunProvider
): BrowserProviderAdapter {
  const { binding, options } = provider;
  // Options are read on every use, like `recording` and `guardrails` below.
  const keepAliveMs = () =>
    options.keepAliveMs ?? BROWSER_SESSION_KEEP_ALIVE_DEFAULT_MS;

  return {
    get keepAliveMs() {
      return keepAliveMs();
    },

    async create() {
      return acquireBrowserSession(binding, {
        keepAliveMs: keepAliveMs(),
        recording: options.recording,
        guardrails: options.guardrails
      });
    },

    async isAlive(sessionId) {
      try {
        await listBrowserTargets(binding, sessionId);
        return true;
      } catch (error) {
        if (isMissingBrowserSession(error)) return false;
        throw error;
      }
    },

    async connect(sessionId, connectOptions) {
      try {
        return await connectBrowserSession(binding, sessionId, connectOptions);
      } catch (error) {
        if (isMissingBrowserSession(error)) {
          throw new BrowserSessionGoneError(sessionId, { cause: error });
        }
        throw error;
      }
    },

    async close(sessionId) {
      try {
        await closeBrowserSession(binding, sessionId);
      } catch (error) {
        if (!isMissingBrowserSession(error)) throw error;
      }
    },

    spec(sessionId) {
      return loadCdpSpec({ browser: binding, sessionId });
    },

    async liveView(sessionId, mode) {
      try {
        const targets = await listBrowserTargets(binding, sessionId);
        return createLiveView(sessionId, targets, mode);
      } catch (error) {
        if (isMissingBrowserSession(error)) return undefined;
        throw error;
      }
    }
  };
}
