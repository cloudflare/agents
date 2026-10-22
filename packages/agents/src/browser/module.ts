/**
 * The browser module: the `browser` object model-written code drives a
 * browser with, defined once. `browserTool`'s sandbox exposes it as the
 * `browser` global, and the same functions, docs and rules are what a
 * Workspace module would expose later. Internal — not an entry point.
 *
 * Every function takes one options object and is backed by a
 * `BrowserSession`, which validates the input.
 */
import type {
  BrowserAttachInput,
  BrowserDebugLogInput,
  BrowserSendInput,
  BrowserSession,
  BrowserSpecInput
} from "./session";

/** One function on the `browser` object, as the host runs it. */
export type BrowserFunction = (input: unknown) => Promise<unknown>;

interface BrowserFunctionDefinition {
  /** One line for the model: how to call it and what it returns. */
  doc: string;
  call(session: BrowserSession, input: unknown): Promise<unknown>;
}

// SAFETY: Each session method validates its input before using it, so the
// casts below only tell TypeScript what the session checks at runtime.
const BROWSER_FUNCTIONS = {
  cdp: {
    doc: '`browser.cdp({ method, params?, sessionId?, timeoutMs? })` sends a CDP command and returns its result without the JSON-RPC envelope. Page-scoped commands take `sessionId: "active"`: `await browser.cdp({ method: "Page.navigate", params: { url }, sessionId: "active" })` returns `{ frameId, errorText? }`.',
    call: (session, input) => session.send(input as BrowserSendInput)
  },
  attachToTarget: {
    doc: "`browser.attachToTarget({ targetId })` makes an open tab active and returns `{ sessionId }`.",
    call: (session, input) =>
      session.attachToTarget(input as BrowserAttachInput)
  },
  spec: {
    doc: '`browser.spec()` lists the protocol\'s domains; `browser.spec({ domain: "Page" })` returns one domain\'s `{ commands, events, types }`. Big domains get cut short in your result, so filter in code: `(await browser.spec({ domain: "Network" })).commands.find((c) => c.name === "enable")`.',
    call: (session, input) => session.spec(input as BrowserSpecInput)
  },
  getDebugLog: {
    doc: "`browser.getDebugLog()` returns recent protocol traffic, for when a command fails or times out.",
    call: (session, input) => session.getDebugLog(input as BrowserDebugLogInput)
  },
  clearDebugLog: {
    doc: "`browser.clearDebugLog()` forgets the traffic recorded so far.",
    call: (session) => session.clearDebugLog()
  }
} satisfies Record<string, BrowserFunctionDefinition>;

/** The `browser` object's functions, bound to one run's session. */
export function browserFunctions(
  session: BrowserSession
): Record<string, BrowserFunction> {
  return Object.fromEntries(
    Object.entries(BROWSER_FUNCTIONS).map(([name, definition]) => [
      name,
      (input: unknown) => definition.call(session, input)
    ])
  );
}

/** One line per function, for the model. */
export const BROWSER_FUNCTION_DOCS: readonly string[] = Object.values(
  BROWSER_FUNCTIONS
).map((definition) => definition.doc);

/**
 * How to use the browser, one rule per line. Each rule fixes a mistake
 * models make with CDP, or states something about this browser they can't
 * know; leave out what a model knows already. Rules about how the code runs
 * (timeouts, screenshots) belong to whatever runs it.
 */
export const BROWSER_RULES: readonly string[] = [
  "The browser persists between runs: tabs, cookies, and logins are still there next time. You never start or close it.",
  "If the browser was replaced (idle timeout, crash), a notice says so and earlier tabs and logins are gone. Before an action that matters (submitting a form, a purchase), check you're on the page you expect.",
  'Page-scoped commands (Page.*, Runtime.*, DOM.*, Input.*, Network.*, Emulation.*) need sessionId: "active", your tab, which is remembered between runs. Browser.* and Target.* commands take no sessionId.',
  "Other open tabs (Target.getTargets) may belong to other conversations using this browser: don't close, navigate, or attach to a tab you didn't open unless the user asks.",
  "Target.createTarget opens a tab and makes it active. To switch to another open tab, call browser.attachToTarget({ targetId }); the sessionId it returns keeps working in later runs, while one from a raw Target.attachToTarget only works in the current run.",
  "Tabs a page opens itself (popups, target=_blank links) don't become active; a notice lists them.",
  "Runtime.evaluate: pass returnByValue: true, or objects come back as a remote reference with no value, and awaitPromise: true for async expressions. The value is at result.value. A thrown error doesn't reject: check exceptionDetails.",
  "Page.navigate returns before the page loads and doesn't throw when it fails: check errorText, then poll document.readyState with Runtime.evaluate until it is 'complete'.",
  "Pick out what you need inside Runtime.evaluate and return only that. A screenshot over 1 MB fails the run."
];
