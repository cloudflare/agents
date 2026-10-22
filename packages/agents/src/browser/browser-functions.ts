/**
 * The `browser` object model-written code drives a browser with, defined
 * once. `browserTool`'s sandbox exposes it as the `browser` global, and the same functions, docs and rules are what a
 * Workspace module would expose later. Internal — not an entry point.
 *
 * Every function takes one options object. The CDP functions are backed by
 * a `BrowserSession`, which validates the input; `spec` shapes the session's
 * full protocol into pieces small enough for a result. The hosts functions,
 * there only when the browser has internal hostnames, are backed by its
 * `internalHosts`.
 */
import type { BrowserInternalHosts } from "./browser";
import type { InternalHostInfo } from "./internal-hosts";
import {
  validate,
  type BrowserAttachInput,
  type BrowserDebugLogInput,
  type BrowserSendInput,
  type BrowserSession
} from "./session";
import type { SearchableCdpSpec } from "./spec";

/** One function on the `browser` object, as the host runs it. */
export type BrowserFunction = (input: unknown) => Promise<unknown>;

interface BrowserFunctionDefinition {
  /** One line for the model: how to call it and what it returns. */
  doc: string;
  call(session: BrowserSession, input: unknown): Promise<unknown>;
}

/** `browser.spec`'s input. */
interface BrowserSpecInput {
  /** A CDP domain, e.g. `"Page"`. Omit for the list of domains. */
  domain?: string;
}

const SPEC_SCHEMA = {
  type: "object",
  properties: { domain: { type: "string", minLength: 1 } }
} as const;

// SAFETY: Each session method validates its input before using it, so the
// casts below only tell TypeScript what the session checks at runtime.
const BROWSER_FUNCTIONS = {
  cdp: {
    doc: '`browser.cdp({ method, params?, sessionId?, timeoutMs? })` sends a CDP command and returns its result without the JSON-RPC envelope. Page-scoped commands take `sessionId: "active"`: `await browser.cdp({ method: "Page.navigate", params: { url }, sessionId: "active" })` returns `{ frameId, errorText? }`. `timeoutMs` limits this one command. A failed command throws, and the error often says how to fix the call.',
    call: (session, input) => session.send(input as BrowserSendInput)
  },
  attachToTarget: {
    doc: '`browser.attachToTarget({ targetId })` switches to an open tab, with `targetId` from `Target.getTargets`, and makes it active: `sessionId: "active"` points at it from then on. Returns `{ sessionId }` for that tab.',
    call: (session, input) =>
      session.attachToTarget(input as BrowserAttachInput)
  },
  spec: {
    doc: '`browser.spec()` lists the protocol\'s domains as `{ domains: [{ name, description }] }`; `browser.spec({ domain: "Page" })` returns one domain\'s `{ commands, events, types }`, each command a `{ method, description, parameters, returns }`. Big domains get cut short in your result, so filter in code: `(await browser.spec({ domain: "Network" })).commands.find((c) => c.name === "enable")`.',
    call: async (session, input) => {
      // Check the input before connecting, like the session's own methods.
      const { domain } = validate(
        "browser.spec",
        SPEC_SCHEMA,
        input
      ) as BrowserSpecInput;
      return specResult(await session.spec(), domain);
    }
  },
  getDebugLog: {
    doc: "`browser.getDebugLog({ limit? })` returns recent protocol traffic, newest last (50 entries unless `limit` says otherwise), each `{ at, type, ... }`. Use it when a command fails or times out.",
    call: (session, input) => session.getDebugLog(input as BrowserDebugLogInput)
  },
  clearDebugLog: {
    doc: "`browser.clearDebugLog()` forgets the traffic recorded so far, so the next `getDebugLog` shows only what follows.",
    call: (session) => session.clearDebugLog()
  }
} satisfies Record<string, BrowserFunctionDefinition>;

/**
 * Without a domain, every domain's name and first sentence, which is small;
 * with one, that domain's commands, events and types. The whole protocol is
 * about 650 KB, too much for one result.
 */
function specResult(spec: SearchableCdpSpec, domain: string | undefined) {
  const { domains } = spec;
  if (domain === undefined) {
    return {
      domains: domains.map(({ name, description }) => ({
        name,
        ...(description ? { description: firstSentence(description) } : {})
      })),
      hint: 'browser.spec({ domain: "Page" }) returns one domain\'s commands, events and types.'
    };
  }
  const found = domains.find((d) => d.name === domain);
  if (found) return found;
  const near = domains.find(
    (d) => d.name.toLowerCase() === domain.toLowerCase()
  );
  throw new Error(
    `No CDP domain named '${domain}'.` +
      (near
        ? ` Did you mean '${near.name}'?`
        : " browser.spec() lists the domains.")
  );
}

/** A CDP description's first sentence, for the list of domains. */
function firstSentence(text: string): string {
  return text.match(/^[\s\S]*?\.(?=\s|$)/)?.[0] ?? text;
}

interface HostsFunctionDefinition {
  doc: string;
  /** Only offered when at least one host is assignable. */
  assignable?: true;
  call(hosts: BrowserInternalHosts, input: unknown): Promise<unknown>;
}

/** The `host` field of a hosts function's input, or a fix-it error. */
function hostOf(name: string, input: unknown): string {
  const host =
    typeof input === "object" && input !== null
      ? (input as { host?: unknown }).host
      : undefined;
  if (typeof host !== "string") {
    throw new Error(
      `browser.${name} needs { host }: the bare hostname, like "preview.internal".`
    );
  }
  return host;
}

const HOSTS_FUNCTIONS = {
  listHosts: {
    doc: "`browser.listHosts()` returns each internal site and the target it points at.",
    call: (hosts) => hosts.list()
  },
  assignHost: {
    doc: '`browser.assignHost({ host, target })` points an assignable site at a target matching its schema and returns `{ url }`; `host` is the bare hostname, like "preview.internal". Navigate to the url next. It stays assigned across runs.',
    assignable: true,
    call: (hosts, input) =>
      hosts.assign(
        hostOf("assignHost", input),
        (input as { target?: unknown }).target
      )
  },
  clearHost: {
    doc: "`browser.clearHost({ host })` unassigns a site and returns `{ cleared }`. An unassigned site answers 502.",
    assignable: true,
    call: async (hosts, input) => ({
      cleared: await hosts.clear(hostOf("clearHost", input))
    })
  }
} satisfies Record<string, HostsFunctionDefinition>;

/** The hosts functions to offer: assign and clear only if any host can be. */
function hostsFunctions(
  infos: InternalHostInfo[]
): [string, HostsFunctionDefinition][] {
  const assignable = infos.some((info) => info.assignable);
  return Object.entries(HOSTS_FUNCTIONS).filter(
    ([, definition]: [string, HostsFunctionDefinition]) =>
      assignable || !definition.assignable
  );
}

/**
 * The `browser` object's functions, bound to one run's session, plus the
 * hosts functions when the browser has internal hostnames.
 */
export function browserFunctions(
  session: BrowserSession,
  hosts?: BrowserInternalHosts
): Record<string, BrowserFunction> {
  const functions: Record<string, BrowserFunction> = Object.fromEntries(
    Object.entries(BROWSER_FUNCTIONS).map(([name, definition]) => [
      name,
      (input: unknown) => definition.call(session, input)
    ])
  );
  if (hosts) {
    for (const [name, definition] of hostsFunctions(hosts.describe())) {
      functions[name] = (input: unknown) => definition.call(hosts, input);
    }
  }
  return functions;
}

/** How one internal site reads in the docs. */
function describeHost(info: InternalHostInfo): string {
  const description = info.description ? ` — ${info.description}` : "";
  const target = info.assignable
    ? `. Assignable; target schema: ${JSON.stringify(info.targetSchema ?? {})}`
    : "";
  return `- ${info.url}${description}${target}`;
}

/**
 * The `browser` object's docs for the model, in Markdown: one line per
 * function, then the internal sites when the browser has any.
 */
export function browserFunctionDocs(hosts?: BrowserInternalHosts): string {
  const infos = hosts?.describe() ?? [];
  const functions = [
    ...Object.values(BROWSER_FUNCTIONS),
    ...(hosts ? hostsFunctions(infos).map(([, definition]) => definition) : [])
  ];
  const lines = functions.map((definition) => `- ${definition.doc}`);
  if (!hosts) return lines.join("\n");
  return [
    ...lines,
    "",
    "## Internal sites",
    "",
    "The browser can open these sites, served by your agent rather than the internet. Plain http only: no https:// and no WebSockets, so a dev server's hot reload won't connect; reload the page instead.",
    "",
    ...infos.map(describeHost)
  ].join("\n");
}

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
