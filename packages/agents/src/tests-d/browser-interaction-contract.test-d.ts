/**
 * Type-level contract tests for the provider-agnostic browser interaction
 * contract. The envelope fields, targeting union, verb set, and error codes
 * here mirror the resolved interaction-layer design ticket field-for-field —
 * if these break, the contract changed and the ticket needs an amendment.
 */
import type {
  ActionEnvelope,
  ActionTarget,
  BrowserSnapshot,
  SnapshotNode,
  BrowserVerbs,
  ConsoleMessage,
  DialogFact,
  DownloadFact,
  ElementRef,
  InteractionProvider,
  InteractionErrorCode,
  ProviderActionResult,
  RequestRecord,
  SettleTimeoutReason,
  TabInfo,
  VerbName
} from "../browser/interaction";
import { BrowserInteractionError } from "../browser/interaction";

// ---------------------------------------------------------------------------
// Outcome envelope — fixed-size, counts not content.
// { ok, action, url, urlChanged, status?, settled, settleTimeoutReason?,
//   tabsChanged?, dialog?, download?, consoleDelta: {errors, warnings},
//   sessionRestarted?, warnings[] } + reserved humanHandoffResolved?
// ---------------------------------------------------------------------------

declare const envelope: ActionEnvelope;

envelope.ok satisfies boolean;
envelope.action satisfies VerbName;
envelope.url satisfies string;
envelope.urlChanged satisfies boolean;
envelope.status satisfies number | undefined;
envelope.settled satisfies boolean;
envelope.settleTimeoutReason satisfies string | undefined;
envelope.tabsChanged satisfies
  | { opened: TabInfo[]; closed: string[] }
  | undefined;
envelope.dialog satisfies DialogFact | undefined;
envelope.download satisfies DownloadFact | undefined;
envelope.consoleDelta satisfies { errors: number; warnings: number };
envelope.sessionRestarted satisfies boolean | undefined;
// Reserved for the HITL handoff wave — must exist on the type now so the
// field name is contract, not accident.
envelope.humanHandoffResolved satisfies boolean | undefined;
envelope.warnings satisfies string[];

// The envelope is fixed-size: unknown fields must not typecheck.
// @ts-expect-error — the envelope has no snapshot; snapshot() is one line away
envelope.snapshot;
// @ts-expect-error — console content is on-demand via console(), not pushed
envelope.consoleMessages;

// A minimal successful envelope needs no optional fields.
const minimal: ActionEnvelope = {
  ok: true,
  action: "click",
  url: "https://example.com",
  urlChanged: false,
  settled: true,
  consoleDelta: { errors: 0, warnings: 0 },
  warnings: []
};
minimal satisfies ActionEnvelope;

// consoleDelta is counts, not content.
// @ts-expect-error — errors is a count
envelope.consoleDelta.errors satisfies string[];

// ---------------------------------------------------------------------------
// Targeting — explicit three-way union, no mixing, no string-sniffing.
// ---------------------------------------------------------------------------

const byRef: ActionTarget = { ref: "e12" };
const bySelector: ActionTarget = { selector: "#submit" };
const byCoords: ActionTarget = { x: 100, y: 200 };
byRef satisfies ActionTarget;
bySelector satisfies ActionTarget;
byCoords satisfies ActionTarget;

// @ts-expect-error — ref and selector are mutually exclusive
const _mixed1: ActionTarget = { ref: "e12", selector: "#submit" };
// @ts-expect-error — ref and coordinates are mutually exclusive
const _mixed2: ActionTarget = { ref: "e12", x: 1, y: 2 };
// @ts-expect-error — coordinates require both x and y
const _halfCoords: ActionTarget = { x: 100 };
// @ts-expect-error — a bare string is not a target (no string-sniffing)
const _bare: ActionTarget = "#submit";

// ---------------------------------------------------------------------------
// Snapshot — plain-data structured nodes + compact text, opaque refs.
// ---------------------------------------------------------------------------

declare const snapshot: BrowserSnapshot;
snapshot.url satisfies string;
snapshot.text satisfies string;
snapshot.nodes satisfies SnapshotNode[];

declare const node: SnapshotNode;
node.role satisfies string;
node.name satisfies string | undefined;
// Refs are opaque strings, present only on interactable nodes.
node.ref satisfies ElementRef | undefined;
node.children satisfies SnapshotNode[] | undefined;

// Refs never expose backing identity (loaderId/backendNodeId stay internal).
// @ts-expect-error — no CDP identity on nodes
node.backendNodeId;

// ---------------------------------------------------------------------------
// Verbs — the v1 set, model-facing signatures returning full envelopes.
// ---------------------------------------------------------------------------

declare const browser: BrowserVerbs;

browser.goto("https://example.com") satisfies Promise<ActionEnvelope>;
browser.back() satisfies Promise<ActionEnvelope>;
browser.reload() satisfies Promise<ActionEnvelope>;

browser.tabs() satisfies Promise<TabInfo[]>;
browser.openTab("https://example.com") satisfies Promise<ActionEnvelope>;
browser.selectTab("tab-1") satisfies Promise<ActionEnvelope>;
browser.closeTab("tab-1") satisfies Promise<ActionEnvelope>;

browser.click({ ref: "e12" }) satisfies Promise<ActionEnvelope>;
browser.fill({ selector: "#q" }, "hello") satisfies Promise<ActionEnvelope>;
browser.type({ ref: "e3" }, "slow text") satisfies Promise<ActionEnvelope>;
browser.press("Enter") satisfies Promise<ActionEnvelope>;
browser.select({ ref: "e4" }, "option-a") satisfies Promise<ActionEnvelope>;
browser.select({ ref: "e4" }, ["a", "b"]) satisfies Promise<ActionEnvelope>;
browser.hover({ ref: "e5" }) satisfies Promise<ActionEnvelope>;
browser.scroll({ deltaY: 400 }) satisfies Promise<ActionEnvelope>;

browser.waitFor({ text: "Order confirmed" }) satisfies Promise<ActionEnvelope>;
browser.waitFor({
  textGone: "Loading",
  timeoutMs: 5000
}) satisfies Promise<ActionEnvelope>;
// Conjunction is legal and defined: wait until both conditions hold.
browser.waitFor({
  text: "Order confirmed",
  textGone: "Processing"
}) satisfies Promise<ActionEnvelope>;
// An empty condition has nothing to wait for and must not typecheck.
// @ts-expect-error — at least one of text/textGone is required
browser.waitFor({});
// @ts-expect-error — timeoutMs alone is not a wait condition
browser.waitFor({ timeoutMs: 5000 });

// waitFor timeouts are representable in the settle vocabulary.
"text" satisfies SettleTimeoutReason;
"text-gone" satisfies SettleTimeoutReason;

browser.snapshot() satisfies Promise<BrowserSnapshot>;
browser.screenshot() satisfies Promise<{ format: string; base64: string }>;
browser.evaluate("document.title") satisfies Promise<unknown>;
browser.console() satisfies Promise<ConsoleMessage[]>;
browser.requests() satisfies Promise<RequestRecord[]>;

browser.handleDialog("accept") satisfies Promise<ActionEnvelope>;
browser.handleDialog("dismiss") satisfies Promise<ActionEnvelope>;

// click takes a target, not a bare selector string.
// @ts-expect-error — no string-sniffing
browser.click("#submit");

// drag/upload are deferred to P1 — not on the v1 surface.
// @ts-expect-error — drag is not a v1 verb
browser.drag;
// @ts-expect-error — upload is not a v1 verb
browser.upload;

// ---------------------------------------------------------------------------
// Provider seam — verb-level: providers own action + actionability + settle
// and return everything the envelope needs EXCEPT session-level facts
// (sessionRestarted, humanHandoffResolved), which the session core adds.
// ---------------------------------------------------------------------------

declare const provider: InteractionProvider;

provider.name satisfies string;
provider.click({ ref: "e1" }) satisfies Promise<ProviderActionResult>;
provider.snapshot() satisfies Promise<BrowserSnapshot>;
provider.dispose() satisfies Promise<void>;

declare const providerResult: ProviderActionResult;
providerResult.ok satisfies boolean;
providerResult.settled satisfies boolean;
// @ts-expect-error — session mortality is the core's fact, not the provider's
providerResult.sessionRestarted;
// @ts-expect-error — handoff resolution is the core's fact, not the provider's
providerResult.humanHandoffResolved;

// A provider result plus the session-level facts is a full envelope.
declare const restarted: boolean;
const full: ActionEnvelope = { ...providerResult, sessionRestarted: restarted };
full satisfies ActionEnvelope;

// ---------------------------------------------------------------------------
// Errors — machine codes + fix-oriented teaching.
// ---------------------------------------------------------------------------

"STALE_REF" satisfies InteractionErrorCode;
"TARGET_NOT_FOUND" satisfies InteractionErrorCode;
"NOT_INTERACTIVE" satisfies InteractionErrorCode;
"DIALOG_BLOCKED" satisfies InteractionErrorCode;
"SESSION_RESTARTED" satisfies InteractionErrorCode;
"NAVIGATION_TIMEOUT" satisfies InteractionErrorCode;

// @ts-expect-error — codes are a closed union, not arbitrary strings
"SOMETHING_ELSE" satisfies InteractionErrorCode;

declare const error: BrowserInteractionError;
error.code satisfies InteractionErrorCode;
error.message satisfies string;
// NOT_INTERACTIVE preserves the actionability cause instead of erasing it.
error.detail satisfies string | undefined;
error satisfies Error;
