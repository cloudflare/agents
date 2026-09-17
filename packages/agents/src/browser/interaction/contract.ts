/**
 * The provider-agnostic browser interaction contract: plain-data types shared
 * by every lane (hand-rolled CDP, `@cloudflare/playwright`) and every
 * projection (codemode verbs today; discrete tools / WebMCP later).
 *
 * Everything here is serializable data — no live object handles ever cross
 * the model boundary. Providers implement {@link InteractionProvider}; the
 * model-facing surface is {@link BrowserVerbs}. The only difference between
 * the two is that the session core adds session-level facts
 * (`sessionRestarted`, `humanHandoffResolved`) that a provider cannot know.
 *
 * Raw CDP access (`cdp.send`, target attachment, `cdp.spec`) is a first-class
 * co-surface next to these verbs, not part of this contract: hosts choose to
 * expose verbs, CDP, or both. Nothing here assumes the verbs are the only way
 * the model drives the browser.
 */

import type { VerbName } from "./verbs";

// ---------------------------------------------------------------------------
// Refs and targeting
// ---------------------------------------------------------------------------

/**
 * An opaque element reference minted by a snapshot. Deliberately
 * short-lived. The lifetime contract:
 *
 * - navigation always invalidates a ref;
 * - a provider may invalidate refs on re-snapshot (validity beyond the
 *   minting snapshot is provider quality-of-implementation — the CDP lane
 *   backs refs with loader identity + `backendNodeId` and may keep them
 *   while the element survives; never rely on it);
 * - the one guarantee: a ref never silently resolves to a different element
 *   than the one it named — stale use fails with a structured `STALE_REF`
 *   teaching error, never a guess.
 *
 * Backing identity (CDP `loaderId`/`backendNodeId`, Playwright `aria-ref`)
 * never leaks through this type.
 */
export type ElementRef = string;

/**
 * Where an element verb should act. Exactly one addressing mode, as distinct
 * named fields — no string-sniffing. Taught precedence: `ref` first (from
 * `snapshot()`), CSS `selector` for known-selector or poor-accessibility
 * cases, `x`/`y` coordinates last (paired with `screenshot()`).
 */
export type ActionTarget =
  | { ref: ElementRef; selector?: never; x?: never; y?: never }
  | { selector: string; ref?: never; x?: never; y?: never }
  | { x: number; y: number; ref?: never; selector?: never };

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * One accessibility node in the structured snapshot projection. Distilled:
 * refs appear only on visible, interactable elements; state fields appear
 * only when meaningful for the role.
 */
export interface SnapshotNode {
  role: string;
  name?: string;
  /** Present only on visible, interactable nodes. */
  ref?: ElementRef;
  /** Current value for inputs/comboboxes. */
  value?: string;
  checked?: boolean | "mixed";
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  children?: SnapshotNode[];
}

/**
 * Dual projection from one accessibility-tree traversal: structured
 * {@link SnapshotNode} data for code to filter/map, and a compact `text`
 * rendering (role/name/state lines) for direct model reading.
 */
export interface BrowserSnapshot {
  url: string;
  title?: string;
  /** Compact human/model-readable rendering of `nodes`. */
  text: string;
  nodes: SnapshotNode[];
}

// ---------------------------------------------------------------------------
// Envelope facts
// ---------------------------------------------------------------------------

/** Tab identity is a stable opaque id — never a CDP targetId. */
export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

/** Pushed fact: tabs opened/closed as a side effect of the last action. */
export interface TabsChanged {
  opened: TabInfo[];
  /** Ids of tabs that closed. */
  closed: string[];
}

/** Pushed fact: a dialog opened and now blocks the page. */
export interface DialogFact {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
}

/** Pushed fact: the last action triggered a download (never silent). */
export interface DownloadFact {
  url: string;
  suggestedFilename?: string;
}

/**
 * Console activity since the previous action, as counts. Content stays out
 * of the envelope — read it on demand with `console()`.
 */
export interface ConsoleDelta {
  errors: number;
  warnings: number;
}

/**
 * Which bounded wait gave up, when `settled` is `false`. The first three are
 * post-action settle machinery; `text`/`text-gone` are `waitFor` conditions
 * that did not hold within their timeout.
 */
export type SettleTimeoutReason =
  | "navigation"
  | "requests"
  | "dom-quiet"
  | "text"
  | "text-gone";

/**
 * The fixed-size outcome envelope every state-changing verb returns. Counts
 * not content; small facts are pushed, streams are on-demand; no automatic
 * snapshot — `snapshot()` is one line away.
 */
export interface ActionEnvelope {
  ok: boolean;
  action: VerbName;
  url: string;
  urlChanged: boolean;
  /** HTTP status of the main document, when the action navigated. */
  status?: number;
  /**
   * Whether the page reached quiescence within bounds. Settle never throws:
   * `false` plus {@link settleTimeoutReason} reports what timed out.
   */
  settled: boolean;
  settleTimeoutReason?: SettleTimeoutReason;
  tabsChanged?: TabsChanged;
  dialog?: DialogFact;
  download?: DownloadFact;
  consoleDelta: ConsoleDelta;
  /**
   * Set by the session core when this action ran in a freshly recreated
   * browser: all page state was lost — verify, don't assume.
   */
  sessionRestarted?: boolean;
  /**
   * Reserved for the HITL wave: set on the first action after a human
   * handoff resolved, instructing the model to verify browser state.
   */
  humanHandoffResolved?: boolean;
  warnings: string[];
}

/**
 * What a provider returns for a state-changing verb: the envelope minus the
 * session-level facts only the session core can know.
 */
export type ProviderActionResult = Omit<
  ActionEnvelope,
  "sessionRestarted" | "humanHandoffResolved"
>;

// ---------------------------------------------------------------------------
// On-demand reads (bounded ring buffers, filtered in code before context)
// ---------------------------------------------------------------------------

export interface ConsoleMessage {
  level: "log" | "info" | "warning" | "error" | "debug";
  text: string;
  url?: string;
  timestamp: number;
}

export interface RequestRecord {
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  /** Set when the request failed before a response. */
  failure?: string;
}

export interface ConsoleReadOptions {
  level?: ConsoleMessage["level"];
  limit?: number;
}

export interface RequestReadOptions {
  urlContains?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Verb options
// ---------------------------------------------------------------------------

export interface NavigateOptions {
  timeoutMs?: number;
}

export interface ClickOptions {
  button?: "left" | "middle" | "right";
  clickCount?: number;
}

export interface TypeOptions {
  /** Delay between keystrokes. */
  delayMs?: number;
}

export interface ScrollOptions {
  /** Scroll within this element; defaults to the page. */
  target?: ActionTarget;
  deltaX?: number;
  deltaY?: number;
}

/**
 * What `waitFor` waits for. At least one condition is required — an empty
 * condition has nothing to wait for. When both are present, `waitFor`
 * resolves only once **both** hold (conjunction). On timeout it reports
 * `settled: false` with `settleTimeoutReason` `"text"` or `"text-gone"`
 * (the first unmet condition) — it never throws.
 */
export type WaitForCondition = { timeoutMs?: number } & (
  | {
      /** Wait until this text is visible on the page. */
      text: string;
      /** Optionally also wait until this text is gone from the page. */
      textGone?: string;
    }
  | {
      /** Wait until this text is gone from the page. */
      textGone: string;
      /** Optionally also wait until this text is visible on the page. */
      text?: string;
    }
);

export interface ScreenshotOptions {
  fullPage?: boolean;
}

export interface ScreenshotResult {
  format: "png" | "jpeg";
  base64: string;
}

export interface HandleDialogOptions {
  /** Text to enter before accepting a `prompt` dialog. */
  promptText?: string;
}

// ---------------------------------------------------------------------------
// The verb set
// ---------------------------------------------------------------------------

/**
 * The v1 verb signatures, generic over the outcome type so the model-facing
 * surface ({@link BrowserVerbs}) and the provider seam
 * ({@link InteractionProvider}) share one definition. `drag` and `upload`
 * are deferred (upload needs a Workers-native `{data | url}` design).
 */
export interface InteractionVerbs<Outcome> {
  // navigate
  goto(url: string, options?: NavigateOptions): Promise<Outcome>;
  back(): Promise<Outcome>;
  reload(): Promise<Outcome>;
  // tabs — stable ids, in-session parallelism
  tabs(): Promise<TabInfo[]>;
  openTab(url?: string): Promise<Outcome>;
  selectTab(tabId: string): Promise<Outcome>;
  closeTab(tabId: string): Promise<Outcome>;
  // act
  click(target: ActionTarget, options?: ClickOptions): Promise<Outcome>;
  /** Set a field's value directly (clears first). For keystrokes use `type`. */
  fill(target: ActionTarget, value: string): Promise<Outcome>;
  /** Type character by character, triggering per-keystroke handlers. */
  type(
    target: ActionTarget,
    text: string,
    options?: TypeOptions
  ): Promise<Outcome>;
  press(key: string): Promise<Outcome>;
  /** Select option(s) by value or visible text (forgiving form semantics). */
  select(target: ActionTarget, values: string | string[]): Promise<Outcome>;
  hover(target: ActionTarget): Promise<Outcome>;
  scroll(options: ScrollOptions): Promise<Outcome>;
  // await
  waitFor(condition: WaitForCondition): Promise<Outcome>;
  // observe
  snapshot(): Promise<BrowserSnapshot>;
  screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>;
  /**
   * Evaluate a JS expression in the page world (the sandbox cannot touch the
   * DOM) and return its JSON-serializable result. For extraction, app-state
   * reads, ground-truth probes, and custom-widget workarounds.
   */
  evaluate(expression: string): Promise<unknown>;
  console(options?: ConsoleReadOptions): Promise<ConsoleMessage[]>;
  requests(options?: RequestReadOptions): Promise<RequestRecord[]>;
  // dialogs
  handleDialog(
    action: "accept" | "dismiss",
    options?: HandleDialogOptions
  ): Promise<Outcome>;
}

/** The model-facing verb surface: full envelopes with session-level facts. */
export type BrowserVerbs = InteractionVerbs<ActionEnvelope>;

/**
 * The seam a lane implements. Verb-level: the provider owns action
 * execution, its own actionability checks (the CDP lane specifies and tests
 * its own subset — no Playwright-parity claims), and bounded settle. The
 * session core owns everything else: session lifecycle, ref-free session
 * facts, and assembling {@link ActionEnvelope}s from
 * {@link ProviderActionResult}s. Providers are selected by config/capability
 * detection — never hard-coupled to a runtime.
 */
export interface InteractionProvider extends InteractionVerbs<ProviderActionResult> {
  /** Lane identifier, e.g. `"cdp"` or `"playwright"`. */
  readonly name: string;
  /** Detach from the browser without closing the underlying session. */
  dispose(): Promise<void>;
}
