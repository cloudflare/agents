/**
 * Type-level tests for the engine-discriminated browser option unions.
 * Chromium-only options must be compile errors when `browser: "kitesurf"` —
 * the discriminant removes them from the arm instead of relying on runtime
 * guards alone.
 */
import type { ConnectBrowserOptions } from "../browser/browser-run";
import type { OneShotBrowserSessionOptions } from "../browser/session-core";

// ---------------------------------------------------------------------------
// connectBrowser — Chromium (the default engine) accepts the full option set.
// ---------------------------------------------------------------------------

const chromiumImplicit: ConnectBrowserOptions = {
  timeoutMs: 5_000,
  keepAliveMs: 60_000,
  includeTargets: true,
  recording: true
};

const chromiumExplicit: ConnectBrowserOptions = {
  browser: "chromium",
  keepAliveMs: 60_000
};

// Kitesurf takes only timeoutMs.
const kitesurf: ConnectBrowserOptions = {
  browser: "kitesurf",
  timeoutMs: 5_000
};

const kitesurfKeepAlive: ConnectBrowserOptions = {
  browser: "kitesurf",
  // @ts-expect-error — keepAliveMs is Chromium-only
  keepAliveMs: 60_000
};

const kitesurfTargets: ConnectBrowserOptions = {
  browser: "kitesurf",
  // @ts-expect-error — includeTargets is Chromium-only
  includeTargets: true
};

const kitesurfRecording: ConnectBrowserOptions = {
  browser: "kitesurf",
  // @ts-expect-error — recording is Chromium-only
  recording: true
};

// ---------------------------------------------------------------------------
// openOneShotBrowserSession — same split, plus guardrails on the Chromium arm.
// ---------------------------------------------------------------------------

const oneShotChromium: OneShotBrowserSessionOptions = {
  timeoutMs: 5_000,
  keepAliveMs: 30_000,
  recording: true,
  guardrails: { allowedDomains: ["example.com"] }
};

const oneShotKitesurf: OneShotBrowserSessionOptions = {
  browser: "kitesurf",
  timeoutMs: 5_000
};

const oneShotKitesurfGuardrails: OneShotBrowserSessionOptions = {
  browser: "kitesurf",
  // @ts-expect-error — guardrails are Chromium-only
  guardrails: { allowedDomains: ["example.com"] }
};

const oneShotKitesurfKeepAlive: OneShotBrowserSessionOptions = {
  browser: "kitesurf",
  // @ts-expect-error — keepAliveMs is Chromium-only
  keepAliveMs: 30_000
};

const oneShotKitesurfRecording: OneShotBrowserSessionOptions = {
  browser: "kitesurf",
  // @ts-expect-error — recording is Chromium-only
  recording: true
};

// Reference every fixture so the unused-variable rule stays quiet.
export type _BrowserEngineOptionFixtures = [
  typeof chromiumImplicit,
  typeof chromiumExplicit,
  typeof kitesurf,
  typeof kitesurfKeepAlive,
  typeof kitesurfTargets,
  typeof kitesurfRecording,
  typeof oneShotChromium,
  typeof oneShotKitesurf,
  typeof oneShotKitesurfGuardrails,
  typeof oneShotKitesurfKeepAlive,
  typeof oneShotKitesurfRecording
];
