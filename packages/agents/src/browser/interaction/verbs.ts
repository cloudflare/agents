/**
 * The v1 verb names and their one-line descriptions. The descriptions are
 * contract, not decoration: the model-facing sandbox projection (built in a
 * later slice) fulfills the probe-friendly promise — `Object.keys(browser)`
 * enumerates the verbs and every verb function carries a `.description` —
 * by decorating its verb functions from this record. This module ships the
 * canonical wording; the projection ships the runtime shape.
 */

export const VERB_NAMES = [
  "goto",
  "back",
  "reload",
  "tabs",
  "openTab",
  "selectTab",
  "closeTab",
  "click",
  "fill",
  "type",
  "press",
  "select",
  "hover",
  "scroll",
  "waitFor",
  "snapshot",
  "screenshot",
  "evaluate",
  "console",
  "requests",
  "handleDialog"
] as const;

export type VerbName = (typeof VERB_NAMES)[number];

export const VERB_DESCRIPTIONS: Record<VerbName, string> = {
  goto: "goto(url) — navigate the active tab and wait for the page to settle.",
  back: "back() — go back one history entry in the active tab.",
  reload: "reload() — reload the active tab.",
  tabs: "tabs() — list open tabs as { id, url, title, active }; ids are stable.",
  openTab:
    "openTab(url?) — open a new tab (optionally at url) and make it active.",
  selectTab: "selectTab(tabId) — make the given tab active.",
  closeTab: "closeTab(tabId) — close the given tab.",
  click:
    "click({ref} | {selector} | {x,y}, options?) — click an element; prefer refs from snapshot().",
  fill: "fill(target, value) — set a field's value directly (clears it first); use type() when the page needs per-keystroke events.",
  type: "type(target, text, {delayMs?}) — type text keystroke by keystroke, triggering input handlers.",
  press:
    "press(key) — press a key or combination, e.g. 'Enter' or 'Control+a'.",
  select:
    "select(target, values) — choose <select> option(s) by value or visible text.",
  hover: "hover(target) — move the pointer over an element.",
  scroll:
    "scroll({target?, deltaX?, deltaY?}) — scroll the page or an element.",
  waitFor:
    "waitFor({text?, textGone?, timeoutMs?}) — wait until text appears and/or disappears (at least one condition; both means both must hold); reports settled: false with the unmet condition on timeout instead of throwing.",
  snapshot:
    "snapshot() — accessibility snapshot of the active tab: structured nodes with refs plus a compact text rendering. Take a fresh one after the page changes.",
  screenshot:
    "screenshot({fullPage?}) — capture the active tab as an image; the escalation step when the snapshot is not enough.",
  evaluate:
    "evaluate(expression) — run a JS expression in the page and return its JSON result; this is the only way code reaches the page's DOM.",
  console:
    "console({level?, limit?}) — read recent console messages on demand (the envelope only carries counts).",
  requests:
    "requests({urlContains?, limit?}) — read recent network requests on demand.",
  handleDialog:
    'handleDialog("accept" | "dismiss", {promptText?}) — resolve the currently open dialog; actions are blocked until you do.'
};
