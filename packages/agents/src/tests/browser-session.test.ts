import { describe, expect, it, vi } from "vitest";
import {
  Browser,
  MAX_BROWSER_SCOPES,
  namedBrowserSessionKey,
  type BrowserInternalHosts
} from "../browser/browser";
import { browserFunctions } from "../browser/browser-functions";
import { browserRun } from "../browser/providers/browser-run";
import { conversationScope } from "../browser/scope";
import {
  BrowserSession,
  lockedScopes,
  type BrowserSessionReport,
  type BrowserSource
} from "../browser/session";
import type {
  BrowserSessionLock,
  BrowserSessionStore,
  StoredBrowserSession
} from "../browser/session-store";

class MemorySessionStore implements BrowserSessionStore {
  sessions = new Map<string, StoredBrowserSession>();
  #queues = new Map<string, Promise<void>>();

  async acquireLock(key: string): Promise<BrowserSessionLock> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    this.#queues.set(
      key,
      previous.then(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      )
    );
    await previous;
    return { release: () => release() };
  }
  async get(key: string) {
    return this.sessions.get(key);
  }
  async set(key: string, session: StoredBrowserSession) {
    this.sessions.set(key, session);
  }
  async delete(key: string) {
    this.sessions.delete(key);
  }
  async list(prefix: string) {
    const result = new Map<string, StoredBrowserSession>();
    for (const [key, session] of this.sessions) {
      if (key.startsWith(prefix)) result.set(key, session);
    }
    return result;
  }
}

interface Tab {
  targetId: string;
  /** A worker has no Page domain. */
  type: "page" | "service_worker";
  url: string;
  title?: string;
  openerId?: string;
}

interface SentCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/**
 * One Browser Run browser: a set of tabs shared by every socket attached to
 * it, so state survives between executions like the real thing.
 */
class FakeBrowserInstance {
  tabs: Tab[] = [];
  #nextTarget = 0;
  #nextSession = 0;
  /** CDP session id → target id, for page-scoped commands. */
  attached = new Map<string, string>();
  /** Every socket open to this browser, for events. */
  sockets = new Set<FakeSocket>();
  /** CDP session id → the domains enabled in it. */
  enabled = new Map<string, Set<string>>();
  /**
   * Tabs a dialog nobody answered has blocked: their page commands never
   * reply, except Page.reload, which clears it.
   */
  blocked = new Set<string>();

  /** Whether a command sent now gets a reply, as on Browser Run. */
  answers(command: SentCommand): boolean {
    const target = command.sessionId && this.attached.get(command.sessionId);
    if (!target || !this.blocked.has(target)) return true;
    if (command.method !== "Page.reload") return false;
    this.blocked.delete(target);
    return true;
  }

  /**
   * Send an event to every CDP session attached to `targetId` with the
   * event's domain enabled, as Chrome does.
   */
  emit(targetId: string, method: string, params: Record<string, unknown>) {
    const domain = method.split(".")[0];
    for (const [sessionId, target] of this.attached) {
      if (target !== targetId) continue;
      if (!this.enabled.get(sessionId)?.has(domain)) continue;
      for (const socket of this.sockets) {
        if (socket.sessions.has(sessionId)) {
          socket.event({ method, params, sessionId });
        }
      }
    }
  }

  /**
   * Navigate a tab the way Chrome reports it: the main document's request,
   * a redirect, an image the observer should ignore, the response, then
   * the commit.
   */
  navigate(targetId: string, url: string): void {
    const tab = this.tabs.find((t) => t.targetId === targetId);
    if (!tab) return;
    if (url.startsWith("https://refused.example")) {
      // Nothing listens there: the request fails, and nothing commits.
      this.emit(targetId, "Network.requestWillBeSent", {
        requestId: "doc-refused",
        type: "Document",
        frameId: targetId,
        request: { url }
      });
      this.emit(targetId, "Network.loadingFailed", {
        requestId: "doc-refused",
        type: "Document",
        errorText: "net::ERR_CONNECTION_REFUSED"
      });
      return;
    }
    const redirectFrom = `${url}?from=redirect`;
    const request = (requestUrl: string, extra = {}) =>
      this.emit(targetId, "Network.requestWillBeSent", {
        requestId: "doc-1",
        type: "Document",
        frameId: targetId,
        request: { url: requestUrl },
        ...extra
      });
    request(redirectFrom);
    request(url, { redirectResponse: { url: redirectFrom, status: 302 } });
    this.emit(targetId, "Network.requestWillBeSent", {
      requestId: "img-1",
      type: "Image",
      frameId: targetId,
      request: { url: `${url}/logo.png` }
    });
    this.emit(targetId, "Network.responseReceived", {
      requestId: "doc-1",
      type: "Document",
      frameId: targetId,
      response: { url, status: 200 }
    });
    tab.url = url;
    this.emit(targetId, "Page.frameNavigated", {
      frame: { id: targetId, url }
    });
  }

  addTab(url = "about:blank", openerId?: string): string {
    const targetId = `target-${++this.#nextTarget}`;
    this.tabs.push({
      targetId,
      type: "page",
      url,
      ...(openerId ? { openerId } : {})
    });
    return targetId;
  }

  handle(command: SentCommand): { result?: unknown; error?: unknown } {
    const params = command.params ?? {};
    switch (command.method) {
      case "Target.getTargetInfo": {
        const tab = this.tabs.find((t) => t.targetId === params.targetId);
        return tab
          ? { result: { targetInfo: tab } }
          : { error: { code: -32602, message: "No target with given id" } };
      }
      case "Target.getTargets":
        return { result: { targetInfos: this.tabs } };
      case "Target.createTarget":
        return {
          result: { targetId: this.addTab(String(params.url ?? "")) }
        };
      case "Target.closeTarget":
        this.tabs = this.tabs.filter((t) => t.targetId !== params.targetId);
        return { result: { success: true } };
      case "Target.attachToTarget": {
        const sessionId = `cdp-${++this.#nextSession}`;
        this.attached.set(sessionId, String(params.targetId));
        return { result: { sessionId } };
      }
      case "Page.getFrameTree": {
        const target = this.attached.get(String(command.sessionId));
        const tab = this.tabs.find((t) => t.targetId === target);
        return tab
          ? { result: { frameTree: { frame: { id: target, url: tab.url } } } }
          : { error: { code: -32001, message: "Session not found." } };
      }
      case "Target.detachFromTarget":
        for (const [sessionId, targetId] of this.attached) {
          if (sessionId === params.sessionId || targetId === params.targetId) {
            this.attached.delete(sessionId);
          }
        }
        return { result: {} };
      default:
        if (command.sessionId && !this.attached.has(command.sessionId)) {
          return {
            error: {
              code: -32001,
              message: `Session with given id not found.`
            }
          };
        }
        const inTab = this.tabs.find(
          (tab) => tab.targetId === this.attached.get(command.sessionId ?? "")
        );
        if (
          inTab?.type === "service_worker" &&
          command.method.startsWith("Page.")
        ) {
          return {
            error: {
              code: -32601,
              message: `'${command.method}' wasn't found`
            }
          };
        }
        // Page-scoped commands without a session fail like Chrome does.
        if (!command.method.startsWith("Target.") && !command.sessionId) {
          return {
            error: {
              code: -32601,
              message: `'${command.method}' wasn't found`
            }
          };
        }
        const [domain, verb] = command.method.split(".");
        if (command.sessionId && (verb === "enable" || verb === "disable")) {
          const domains = this.enabled.get(command.sessionId) ?? new Set();
          if (verb === "enable") domains.add(domain);
          else domains.delete(domain);
          this.enabled.set(command.sessionId, domains);
        }
        if (command.method === "Runtime.evaluate" && command.sessionId) {
          // Simulate a page opening a popup.
          if (params.expression === "openPopup()") {
            this.addTab(
              "https://popup.example/",
              this.attached.get(command.sessionId)
            );
          }
          const navigateTo = /^location = "(.*)"$/.exec(
            String(params.expression)
          )?.[1];
          if (navigateTo) {
            this.navigate(
              String(this.attached.get(command.sessionId)),
              navigateTo
            );
          }
          const pushed = /^history\.pushState\(null, "", "(.*)"\)$/.exec(
            String(params.expression)
          )?.[1];
          if (pushed) {
            const target = String(this.attached.get(command.sessionId));
            this.emit(target, "Page.navigatedWithinDocument", {
              frameId: target,
              url: pushed
            });
          }
          return {
            result: {
              result: { value: this.attached.get(command.sessionId) }
            }
          };
        }
        return { result: {} };
    }
  }
}

class FakeSocket {
  sent: SentCommand[] = [];
  closed = false;
  /** Methods this socket never answers, to stall one connection. */
  silent = new Set<string>();
  /** Methods this socket answers with an error. */
  failing = new Set<string>();
  /** CDP sessions attached over this socket; Chrome drops them on close. */
  readonly sessions = new Set<string>();
  #listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly instance: FakeBrowserInstance) {
    instance.sockets.add(this);
  }
  /** Send this socket an event. */
  event(message: Record<string, unknown>): void {
    if (this.closed) return;
    this.#emit("message", { data: JSON.stringify(message) });
  }
  accept(): void {}
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(fn);
    this.#listeners.set(type, list);
  }
  send(data: string): void {
    // Like a real WebSocket, a closed socket refuses to send.
    if (this.closed) throw new Error("WebSocket is closed");
    const command = JSON.parse(data) as SentCommand;
    this.sent.push(command);
    if (this.silent.has(command.method)) return;
    if (!this.instance.answers(command)) return;
    queueMicrotask(() => {
      const reply = this.failing.has(command.method)
        ? { error: { code: -32000, message: "Internal error" } }
        : this.instance.handle(command);
      const attached = (reply.result as { sessionId?: unknown } | undefined)
        ?.sessionId;
      if (command.method === "Target.attachToTarget") {
        this.sessions.add(String(attached));
      }
      this.#emit("message", {
        data: JSON.stringify({ id: command.id, ...reply })
      });
    });
  }
  close(): void {
    this.closed = true;
    this.instance.sockets.delete(this);
    for (const sessionId of this.sessions) {
      this.instance.attached.delete(sessionId);
    }
    this.#emit("close", {});
  }
  #emit(type: string, event: unknown): void {
    for (const fn of this.#listeners.get(type) ?? []) fn(event);
  }
}

function createFakeBrowser() {
  const instances = new Map<string, FakeBrowserInstance>();
  const sockets: FakeSocket[] = [];
  let created = 0;
  let upgrades = 0;
  /**
   * Answer the nth WebSocket upgrade (from 1) yourself, e.g. to fail or
   * stall an observer's connection.
   */
  const upgradeOverrides = new Map<
    number,
    (upgrade: () => Response) => Promise<Response>
  >();
  /** Methods the nth socket (from 1) never answers. */
  const silentMethods = new Map<number, string[]>();
  /** Methods the nth socket (from 1) answers with an error. */
  const failingMethods = new Map<number, string[]>();

  const browser = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input);
      const method = init?.method ?? "GET";
      const sessionId = url.match(/\/browser\/(session-[^/?]+)/)?.[1];
      if (new Headers(init?.headers).get("Upgrade") === "websocket") {
        const upgrade = (n: number) => {
          const instance = sessionId ? instances.get(sessionId) : undefined;
          if (!instance) return new Response(null, { status: 410 });
          const socket = new FakeSocket(instance);
          socket.silent = new Set(silentMethods.get(n) ?? []);
          socket.failing = new Set(failingMethods.get(n) ?? []);
          sockets.push(socket);
          const response = new Response(null);
          Object.defineProperty(response, "webSocket", { value: socket });
          return response;
        };
        const n = ++upgrades;
        const override = upgradeOverrides.get(n);
        // An override can still upgrade, later, with the default.
        if (override) return override(() => upgrade(n));
        return upgrade(n);
      }
      if (method === "POST") {
        const id = `session-${++created}`;
        const instance = new FakeBrowserInstance();
        // Browser Run starts every browser with one blank tab.
        instance.addTab();
        instances.set(id, instance);
        return Response.json({ sessionId: id });
      }
      if (method === "DELETE") {
        if (sessionId) instances.delete(sessionId);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/json/list")) {
        if (!sessionId || !instances.has(sessionId)) {
          return new Response(null, { status: 410 });
        }
        return Response.json([]);
      }
      if (url.endsWith("/json/protocol")) {
        return Response.json({
          domains: [
            {
              domain: "Page",
              description:
                "Actions and events related to the inspected page. More detail.",
              commands: [{ name: "navigate" }],
              events: [{ name: "loadEventFired" }]
            },
            { domain: "Target" }
          ]
        });
      }
      return new Response(null, { status: 204 });
    }
  };

  return {
    browser,
    instances,
    sockets,
    upgradeOverrides,
    silentMethods,
    failingMethods
  };
}

type Call = [method: string, input: Record<string, unknown>];

/** Call a session method by name, as model code does. */
function call(session: BrowserSession, [method, input]: Call) {
  // SAFETY: The tests only name the session's own methods.
  const fn = (
    session as unknown as Record<string, (input: unknown) => Promise<unknown>>
  )[method];
  return fn.call(session, input);
}

function setup(options: { observer?: boolean } = {}) {
  const fake = createFakeBrowser();
  const store = new MemorySessionStore();
  const browser = new Browser({
    provider: browserRun(fake.browser),
    name: "work",
    store,
    ...(options.observer === undefined ? {} : { observer: options.observer })
  });

  /** Run `calls` as one session and return its results and report. */
  function run(calls: Call[]) {
    return runWith(undefined, calls);
  }

  /** Runs in another scope of the same browser. */
  function scoped(scope: string) {
    return {
      session: () => browser.session({ scope }),
      run: (calls: Call[]) => runWith(scope, calls)
    };
  }

  async function runWith(scope: string | undefined, calls: Call[]) {
    const session = browser.session({ scope });
    const results: unknown[] = [];
    let error: unknown;
    try {
      for (const entry of calls) results.push(await call(session, entry));
    } catch (caught) {
      error = caught;
    }
    return { results, error, report: await session.close() };
  }

  function stored() {
    return store.sessions.get(namedBrowserSessionKey("work"));
  }
  /** The tab a scope of the "work" browser last worked in. */
  function activeTab(scope = "shared") {
    return store.sessions.get(`browser:scope:4:work:${scope}`)?.activeTargetId;
  }
  function instance() {
    return fake.instances.get(stored()!.sessionId)!;
  }
  /** Create the browser up front, so tests can arrange its tabs. */
  async function start() {
    await browser.resolve();
    return instance();
  }

  return {
    ...fake,
    store,
    browser,
    run,
    scoped,
    stored,
    activeTab,
    instance,
    start
  };
}

const evaluateActive: Call = [
  "send",
  {
    method: "Runtime.evaluate",
    params: { expression: "1" },
    sessionId: "active"
  }
];

const createTabCall: Call = [
  "send",
  { method: "Target.createTarget", params: { url: "about:blank" } }
];

/** Make the active page open a popup tab. */
const openPopup: Call = [
  "send",
  {
    method: "Runtime.evaluate",
    params: { expression: "openPopup()" },
    sessionId: "active"
  }
];

/** The target the fake page reports it evaluated in. */
function evaluatedIn(result: unknown): string {
  return (result as { result: { value: string } }).result.value;
}

describe("BrowserSession", () => {
  it('opens a tab of its own for "active" and remembers it', async () => {
    const t = setup();
    const { results, report } = await t.run([evaluateActive]);

    // Not Browser Run's initial blank tab (target-1): it might be anyone's.
    expect(evaluatedIn(results[0])).toBe("target-2");
    expect(report).toEqual({
      restarted: false,
      newTabs: [],
      tabClosed: false,
      tabShared: false,
      notices: [],
      observed: expect.objectContaining({ available: true })
    });
    expect(t.activeTab()).toBe("target-2");
  });
  it("keeps the active tab across executions, even with other tabs open", async () => {
    const t = setup();
    await t.run([evaluateActive]);
    // Another tab appears before the next run (e.g. from Live View).
    t.instance().tabs.unshift({
      targetId: "target-other",
      type: "page",
      url: "about:blank"
    });

    const { results } = await t.run([evaluateActive]);
    expect(evaluatedIn(results[0])).toBe("target-2");
  });

  it("drops the socket when the session closes but keeps the browser", async () => {
    const t = setup();
    await t.run([evaluateActive]);
    await t.run([evaluateActive]);

    // The model's and the observer's, per session.
    expect(t.sockets).toHaveLength(4);
    expect(t.sockets.every((socket) => socket.closed)).toBe(true);
    expect(t.stored()?.sessionId).toBe("session-1");
  });

  it("opens a blank tab when no tabs are open", async () => {
    const t = setup();
    await t.run([
      [
        "send",
        { method: "Target.closeTarget", params: { targetId: "target-1" } }
      ]
    ]);
    expect(t.instance().tabs).toHaveLength(0);

    const { results, report } = await t.run([evaluateActive]);
    expect(evaluatedIn(results[0])).toBe("target-2");
    // A tab the session opened for the agent is not a page-opened tab.
    expect(report?.newTabs).toEqual([]);
  });

  it("never takes a tab it didn't open, even a blank popup", async () => {
    const t = setup();
    // Another scope's page opened a blank popup from the initial tab.
    (await t.start()).addTab("about:blank", "target-1");

    const { results } = await t.run([evaluateActive]);
    expect(evaluatedIn(results[0])).toBe("target-3");
  });
  it("makes a tab created with Target.createTarget active", async () => {
    const t = setup();
    const { results } = await t.run([
      [
        "send",
        { method: "Target.createTarget", params: { url: "about:blank" } }
      ],
      evaluateActive
    ]);
    expect(evaluatedIn(results[1])).toBe("target-2");
    expect(t.activeTab()).toBe("target-2");
  });

  it("makes an attached tab active and returns a stable handle", async () => {
    const t = setup();
    (await t.start()).addTab("https://other.example/");

    const { results } = await t.run([
      ["attachToTarget", { targetId: "target-2" }],
      evaluateActive,
      [
        "send",
        {
          method: "Runtime.evaluate",
          params: { expression: "1" },
          sessionId: "target:target-2"
        }
      ]
    ]);
    expect(results[0]).toEqual({ sessionId: "target:target-2" });
    expect(evaluatedIn(results[1])).toBe("target-2");
    expect(evaluatedIn(results[2])).toBe("target-2");
    expect(t.activeTab()).toBe("target-2");

    // One attach per target per socket.
    const attaches = t.sockets[0].sent.filter(
      (command) => command.method === "Target.attachToTarget"
    );
    expect(attaches).toHaveLength(1);
  });

  it("reattaches after the model detaches from the active tab", async () => {
    const t = setup();
    const { results, error } = await t.run([
      evaluateActive,
      [
        "send",
        {
          method: "Target.detachFromTarget",
          params: { targetId: "target-2" }
        }
      ],
      evaluateActive
    ]);
    expect(error).toBeUndefined();
    expect(evaluatedIn(results[2])).toBe("target-2");
  });

  it("passes a raw Target.attachToTarget through unchanged", async () => {
    const t = setup();
    (await t.start()).addTab("https://other.example/");

    const first = await t.run([
      [
        "send",
        {
          method: "Target.attachToTarget",
          params: { targetId: "target-2", flatten: true }
        }
      ]
    ]);
    const { sessionId } = first.results[0] as { sessionId: string };
    expect(sessionId).toMatch(/^cdp-/);
    expect(t.activeTab()).toBe("target-2");

    // Chrome's id belongs to that run's socket; a later run gets a hint.
    const second = await t.run([
      [
        "send",
        {
          method: "Runtime.evaluate",
          params: { expression: "1" },
          sessionId
        }
      ]
    ]);
    expect(String(second.error)).toContain("don't carry over between runs");
  });

  it("detaches a handle and reattaches on its next use", async () => {
    const t = setup();
    const handle = "target:target-1";
    const { results, error } = await t.run([
      ["attachToTarget", { targetId: "target-1" }],
      [
        "send",
        { method: "Target.detachFromTarget", params: { sessionId: handle } }
      ],
      [
        "send",
        {
          method: "Runtime.evaluate",
          params: { expression: "1" },
          sessionId: handle
        }
      ]
    ]);
    expect(error).toBeUndefined();
    expect(evaluatedIn(results[2])).toBe("target-1");
    const detach = t.sockets[0].sent.find(
      (command) => command.method === "Target.detachFromTarget"
    );
    expect(detach?.params?.sessionId).toMatch(/^cdp-/);
  });

  it("explains that a CDP session id from an earlier run has expired", async () => {
    const t = setup();
    const { error } = await t.run([
      [
        "send",
        {
          method: "Runtime.evaluate",
          params: { expression: "1" },
          sessionId: "cdp-from-an-earlier-run"
        }
      ]
    ]);
    expect(String(error)).toContain("don't carry over between runs");
    expect(String(error)).toContain('sessionId: "active"');
  });

  it("doesn't report a tab another execution created as a popup", async () => {
    const t = setup();
    // Both sessions connect before either creates a tab.
    const a = t.browser.session();
    await call(a, evaluateActive);
    await t.run([
      ["send", { method: "Target.createTarget", params: { url: "" } }]
    ]);

    expect((await a.close())?.newTabs).toEqual([]);
  });

  it("reports tabs the page opened as newTabs without switching to them", async () => {
    const t = setup();
    const { report } = await t.run([openPopup]);
    expect(report?.newTabs).toEqual([
      { targetId: "target-3", url: "https://popup.example/" }
    ]);
    expect(t.activeTab()).toBe("target-2");
  });

  it("reports a popup from a tab reached by a raw Target.attachToTarget", async () => {
    const t = setup();
    (await t.start()).addTab("https://other.example/");
    const { report } = await t.run([
      [
        "send",
        {
          method: "Target.attachToTarget",
          params: { targetId: "target-2", flatten: true }
        }
      ],
      [
        "send",
        {
          method: "Runtime.evaluate",
          params: { expression: "openPopup()" },
          // The fake's first CDP session id.
          sessionId: "cdp-1"
        }
      ]
    ]);
    expect(report?.newTabs).toEqual([
      { targetId: "target-3", url: "https://popup.example/" }
    ]);
  });

  it("drops a popup that closed before the session ended", async () => {
    const t = setup();
    const { report } = await t.run([
      openPopup,
      [
        "send",
        { method: "Target.closeTarget", params: { targetId: "target-3" } }
      ]
    ]);

    expect(report?.newTabs).toEqual([]);
  });

  it("saves a tab switch even if the socket drops before the session ends", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = setup();
      (await t.start()).addTab("https://other.example/");
      const session = t.browser.session();
      await session.attachToTarget({ targetId: "target-2" });
      // Browser Run drops the socket; the browser itself lives on.
      t.sockets[0].close();
      await session.close();

      expect(t.activeTab()).toBe("target-2");
      expect(warn).toHaveBeenCalledOnce();
      const { results } = await t.run([evaluateActive]);
      expect(evaluatedIn(results[0])).toBe("target-2");
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses commands that would end the browser", async () => {
    const t = setup();
    const { error } = await t.run([["send", { method: "Browser.close" }]]);
    expect(String(error)).toContain("managed for you");
    expect(t.sockets).toHaveLength(0);
  });

  it.each([
    "Cloudflare.getLiveView",
    "Cloudflare.handoff",
    "Target.sendMessageToTarget",
    "Target.exposeDevToolsProtocol"
  ])("refuses %s", async (method) => {
    const t = setup();
    const { error } = await t.run([["send", { method }]]);
    expect(String(error)).toContain(`${method} is not available`);
    expect(t.sockets).toHaveLength(0);
  });

  it.each(["Fetch.enable", "Network.setRequestInterception"])(
    "refuses %s, since its code can't answer intercepted requests",
    async (method) => {
      const t = setup();
      const { error } = await t.run([
        ["send", { method, params: {}, sessionId: "active" }]
      ]);
      expect(String(error)).toContain(`${method} is not available`);
      expect(String(error)).toContain("Network.setBlockedURLs");
      expect(t.sockets).toHaveLength(0);
    }
  );

  it("shares one connection between concurrent first calls", async () => {
    const t = setup();
    const session = t.browser.session();
    await Promise.all([
      call(session, evaluateActive),
      session.send({ method: "Target.getTargets" })
    ]);
    await session.close();
    // One for the model, one for the observer.
    expect(t.sockets).toHaveLength(2);
  });

  it("picks a tab afresh after the active tab is closed", async () => {
    const t = setup();
    (await t.start()).addTab("https://second.example/");
    const { results } = await t.run([
      evaluateActive,
      [
        "send",
        { method: "Target.closeTarget", params: { targetId: "target-3" } }
      ],
      evaluateActive
    ]);
    expect(evaluatedIn(results[0])).toBe("target-3");
    // A new blank tab, not another open page.
    expect(evaluatedIn(results[2])).toBe("target-4");
    expect(t.activeTab()).toBe("target-4");
  });

  it("forgets a stored tab closed outside the agent, and says so", async () => {
    const t = setup();
    await t.run([evaluateActive]);
    t.instance().tabs = [];
    // This run never uses "active", so it's the one to say the tab went.
    const { report } = await t.run([
      ["send", { method: "Browser.getVersion" }]
    ]);
    expect(report?.tabClosed).toBe(true);
    expect(t.activeTab()).toBeUndefined();
    expect((await t.run([evaluateActive])).report?.tabClosed).toBe(false);
  });
  it("reports restarted when the browser was replaced, with no stale tab", async () => {
    const t = setup();
    await t.run([evaluateActive]);
    // The platform reclaims the browser between executions.
    t.instances.clear();

    const { results, report } = await t.run([evaluateActive]);
    expect(report?.restarted).toBe(true);
    expect(t.stored()?.sessionId).toBe("session-2");
    expect(evaluatedIn(results[0])).toBe("target-2");
    expect(t.activeTab()).toBe("target-2");
  });

  it("reports nothing for a session that never touched the browser", async () => {
    const t = setup();
    const { report } = await t.run([]);
    expect(report).toBeUndefined();
  });

  it('teaches sessionId: "active" when a page-scoped command lacks one', async () => {
    const t = setup();
    const { error } = await t.run([
      ["send", { method: "Runtime.evaluate", params: { expression: "1" } }]
    ]);
    expect(String(error)).toContain('sessionId: "active"');
  });

  it("explains that CDP events cannot be sent", async () => {
    const t = setup();
    const { error } = await t.run([
      ["send", { method: "Page.loadEventFired", sessionId: "active" }]
    ]);
    // The fake answers every sessioned command, so force the error path.
    expect(error).toBeUndefined();

    const { error: unsessioned } = await t.run([
      ["send", { method: "Page.loadEventFired" }]
    ]);
    expect(String(unsessioned)).toContain("CDP *event*");
  });

  it("validates arguments before touching the browser", async () => {
    const t = setup();
    const { error } = await t.run([["send", { sessionId: "active" }]]);
    expect(String(error)).toContain("Invalid arguments for browser.cdp");
    expect(t.sockets).toHaveLength(0);
  });

  it("refuses calls once closed, and closes once", async () => {
    const t = setup();
    const session = t.browser.session();
    await call(session, evaluateActive);
    expect(await session.close()).toMatchObject({ restarted: false });
    expect(await session.close()).toBeUndefined();
    await expect(call(session, evaluateActive)).rejects.toThrow("closed");
  });

  it("returns the full protocol to host code", async () => {
    const t = setup();
    const { results } = await t.run([["spec", {}]]);
    expect(results[0]).toMatchObject({
      domains: [
        { name: "Page", commands: [{ method: "Page.navigate" }] },
        { name: "Target" }
      ]
    });
  });
});

describe("browser.spec", () => {
  async function spec(input: unknown) {
    const t = setup();
    const session = t.browser.session();
    try {
      return await browserFunctions(session).spec(input);
    } finally {
      await session.close();
    }
  }

  it("lists the protocol's domains, then returns one domain", async () => {
    expect(await spec(undefined)).toEqual({
      domains: [
        {
          name: "Page",
          description: "Actions and events related to the inspected page."
        },
        { name: "Target" }
      ],
      hint: expect.stringContaining('browser.spec({ domain: "Page" })')
    });
    expect(await spec({ domain: "Page" })).toMatchObject({
      name: "Page",
      commands: [{ method: "Page.navigate" }],
      events: [{ event: "Page.loadEventFired" }]
    });
  });

  it("says when a domain doesn't exist", async () => {
    await expect(spec({ domain: "page" })).rejects.toThrow(
      "Did you mean 'Page'?"
    );
    await expect(spec({ domain: "Nope" })).rejects.toThrow(
      "browser.spec() lists the domains"
    );
  });

  it("rejects bad input without starting a browser", async () => {
    const t = setup();
    const session = t.browser.session();
    await expect(browserFunctions(session).spec({ domain: 3 })).rejects.toThrow(
      "Invalid arguments for browser.spec"
    );
    await session.close();
    expect(t.sockets).toHaveLength(0);
  });
});

describe("BrowserSession scopes", () => {
  const createTab: Call = [
    "send",
    { method: "Target.createTarget", params: { url: "about:blank" } }
  ];

  it("keeps an active tab per scope", async () => {
    const t = setup();
    const a = t.scoped("a");
    const b = t.scoped("b");

    const first = await a.run([evaluateActive]);
    const second = await b.run([evaluateActive]);
    const again = await a.run([evaluateActive]);

    expect(evaluatedIn(first.results[0])).toBe("target-2");
    // B doesn't land in A's tab: it gets one of its own.
    expect(evaluatedIn(second.results[0])).toBe("target-3");
    expect(evaluatedIn(again.results[0])).toBe("target-2");
    expect(t.activeTab("a")).toBe("target-2");
    expect(t.activeTab("b")).toBe("target-3");
  });

  it("keeps a tab switch in its own scope", async () => {
    const t = setup();
    const a = t.scoped("a");
    const b = t.scoped("b");
    await a.run([evaluateActive]);
    await b.run([createTab, evaluateActive]);

    const { results } = await a.run([evaluateActive]);
    expect(evaluatedIn(results[0])).toBe("target-2");
  });

  it("doesn't land in a tab another scope just opened", async () => {
    const t = setup();
    const a = t.scoped("a");
    const b = t.scoped("b");
    // A opens a blank tab, and B starts before A's session ends.
    const first = a.session();
    await call(first, createTab);
    const { results } = await b.run([evaluateActive]);
    await first.close();

    expect(evaluatedIn(results[0])).toBe("target-3");
    expect(t.activeTab("a")).toBe("target-2");
  });

  it("tells every scope about a restart, once", async () => {
    const t = setup();
    const a = t.scoped("a");
    const b = t.scoped("b");
    await a.run([evaluateActive]);
    await b.run([evaluateActive]);
    t.instances.clear();

    expect((await a.run([evaluateActive])).report?.restarted).toBe(true);
    expect((await b.run([evaluateActive])).report?.restarted).toBe(true);
    expect((await b.run([evaluateActive])).report?.restarted).toBe(false);
  });

  it("doesn't report a restart to a scope's first run", async () => {
    const t = setup();
    await t.scoped("a").run([evaluateActive]);
    t.instances.clear();

    const { report } = await t.scoped("b").run([evaluateActive]);
    expect(report?.restarted).toBe(false);
  });

  it("reports a popup to the scope whose page opened it", async () => {
    const t = setup();
    const a = t.scoped("a");
    const b = t.scoped("b");
    await b.run([evaluateActive]);
    // A's session is open while B's page opens a popup.
    const first = a.session();
    await call(first, evaluateActive);
    const fromB = await b.run([openPopup]);

    expect((await first.close())?.newTabs).toEqual([]);
    expect(fromB.report?.newTabs.map((tab) => tab.url)).toEqual([
      "https://popup.example/"
    ]);
  });

  it("says when another scope closed this scope's tab", async () => {
    const t = setup();
    const a = t.scoped("a");
    const b = t.scoped("b");
    await a.run([evaluateActive]);
    await b.run([
      [
        "send",
        { method: "Target.closeTarget", params: { targetId: "target-2" } }
      ]
    ]);

    const { results, report } = await a.run([evaluateActive]);
    expect(report?.tabClosed).toBe(true);
    expect(evaluatedIn(results[0])).not.toBe("target-2");
    expect((await a.run([evaluateActive])).report?.tabClosed).toBe(false);
  });

  it("doesn't say the tab was closed when this scope closed it", async () => {
    const t = setup();
    const { report } = await t.run([
      evaluateActive,
      [
        "send",
        { method: "Target.closeTarget", params: { targetId: "target-2" } }
      ],
      evaluateActive
    ]);
    expect(report?.tabClosed).toBe(false);
  });

  it("says when another scope works in this scope's tab", async () => {
    const t = setup();
    const a = t.scoped("a");
    const b = t.scoped("b");
    await a.run([evaluateActive]);

    const { report } = await b.run([
      ["attachToTarget", { targetId: "target-2" }],
      evaluateActive
    ]);
    expect(report?.tabShared).toBe(true);
    expect((await a.run([evaluateActive])).report?.tabShared).toBe(true);
  });

  it(`keeps at most ${MAX_BROWSER_SCOPES} scopes, dropping the least recently used`, async () => {
    const t = setup();
    await t.browser.resolve();
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => ++now);
    try {
      for (let i = 0; i <= MAX_BROWSER_SCOPES; i++) {
        const connected = await t.browser.connect({ scope: `s${i}` });
        connected.cdp.disconnect();
        // Touch s0 again, so s1 is the least recently used.
        if (i === 1) {
          (await t.browser.connect({ scope: "s0" })).cdp.disconnect();
        }
      }
    } finally {
      clock.mockRestore();
    }
    const scopes = await t.store.list("browser:scope:4:work:");
    expect(scopes.size).toBe(MAX_BROWSER_SCOPES);
    expect(scopes.has("browser:scope:4:work:s0")).toBe(true);
    expect(scopes.has("browser:scope:4:work:s1")).toBe(false);
  });
});

describe("Browser.functionDocs", () => {
  it("returns the browser functions in Markdown and the rules", () => {
    const { browser } = setup();
    const docs = browser.functionDocs();
    for (const name of [
      "cdp",
      "attachToTarget",
      "spec",
      "getDebugLog",
      "clearDebugLog"
    ]) {
      expect(docs.functions).toContain(`- \`browser.${name}(`);
    }
    // No internal hosts, so no hosts functions.
    expect(docs.functions).not.toContain("listHosts");
    expect(docs.functions).not.toContain("Internal sites");
    expect(docs.rules.length).toBeGreaterThan(0);
    for (const rule of docs.rules) {
      expect(rule).toEqual(expect.any(String));
      expect(rule.startsWith("-")).toBe(false);
    }
  });

  it("says an oversized screenshot throws, for any code that runs it", () => {
    const { rules } = setup().browser.functionDocs();
    expect(rules.join("\n")).toContain(
      "Page.captureScreenshot throws when its result is over 1 MB"
    );
    expect(rules.join("\n")).not.toContain("fails the run");
  });

  it("returns a fresh copy of the rules each time", () => {
    const { browser } = setup();
    browser.functionDocs().rules.push("changed");
    expect(browser.functionDocs().rules).not.toContain("changed");
  });
});

describe("BrowserSession.functions", () => {
  it("are the browser functions, bound to the session", async () => {
    const t = setup();
    const session = t.browser.session();
    const { functions } = session;
    expect(Object.keys(functions)).toEqual([
      "cdp",
      "attachToTarget",
      "spec",
      "getDebugLog",
      "clearDebugLog"
    ]);
    expect(session.functions).toBe(functions);
    expect(Object.isFrozen(functions)).toBe(true);

    const result = await functions.cdp({
      method: "Runtime.evaluate",
      params: { expression: "1" },
      sessionId: "active"
    });
    expect(evaluatedIn(result)).toBe("target-2");
    await session.close();
    expect(t.activeTab()).toBe("target-2");
  });

  it("validate their input before touching the browser", async () => {
    const t = setup();
    const session = t.browser.session();
    await expect(
      session.functions.cdp({ sessionId: "active" })
    ).rejects.toThrow("Invalid arguments for browser.cdp");
    expect(t.sockets).toHaveLength(0);
    await session.close();
  });
});

describe("BrowserSessionReport.notices", () => {
  it("is empty when nothing happened", async () => {
    const t = setup();
    const { report } = await t.run([evaluateActive]);
    expect(report?.notices).toEqual([]);
  });

  it("tells the model the browser restarted", async () => {
    const t = setup();
    await t.run([evaluateActive]);
    t.instances.clear();
    const { report } = await t.run([evaluateActive]);
    expect(report?.notices).toEqual([
      expect.stringMatching(/^The browser was restarted before this run/)
    ]);
  });

  it("tells the model its tab was closed, and lists new tabs", async () => {
    const t = setup();
    await t.run([evaluateActive]);
    const instance = t.instance();
    instance.tabs = instance.tabs.filter((tab) => tab.targetId !== "target-2");
    const { report } = await t.run([evaluateActive, openPopup]);
    expect(report?.notices).toEqual([
      expect.stringMatching(/^The tab you were working in was closed/),
      `New tabs opened by the page: ${JSON.stringify(report?.newTabs)}`
    ]);
    expect(report?.newTabs).toHaveLength(1);
  });

  it("tells the model another scope works in its tab", async () => {
    const t = setup();
    await t.scoped("a").run([evaluateActive]);
    const b = t.scoped("b").session();
    await call(b, ["attachToTarget", { targetId: "target-2" }]);
    await b.close();
    const { report } = await t.scoped("a").run([evaluateActive]);
    expect(report?.notices).toEqual([
      expect.stringMatching(/^Another conversation using this browser/)
    ]);
  });
});

describe("BrowserSession observer", () => {
  const navigateActive = (url: string): Call => [
    "send",
    {
      method: "Runtime.evaluate",
      params: { expression: `location = "${url}"` },
      sessionId: "active"
    }
  ];

  /** Let background work (the observer's attach) get going. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * Use "active", then make `calls`. No waiting in between: the first
   * command waits for the observer's setup itself.
   */
  async function observed(t: ReturnType<typeof setup>, calls: Call[]) {
    const session = t.browser.session();
    const results: unknown[] = [];
    let error: unknown;
    try {
      const target = evaluatedIn(await call(session, evaluateActive));
      for (const entry of calls) results.push(await call(session, entry));
      return { target, results, error, report: await session.close() };
    } catch (caught) {
      error = caught;
      return { target: "", results, error, report: await session.close() };
    }
  }

  function tabsOf(report: BrowserSessionReport | undefined) {
    const record = report?.observed;
    if (!record?.available) throw new Error("the observer was unavailable");
    return record.tabs;
  }

  /** What the observer's socket sent: the second socket opened. */
  function observerSent(t: ReturnType<typeof setup>) {
    return t.sockets[1].sent.map(({ method }) => method);
  }

  it("is on by default", async () => {
    const t = setup();
    const { report } = await t.run([navigateActive("https://example.com/")]);
    expect(t.sockets).toHaveLength(2);
    expect(report?.observed).toMatchObject({ available: true });
  });

  it("is off with observer: false", async () => {
    const t = setup({ observer: false });
    const { report } = await t.run([navigateActive("https://example.com/")]);
    expect(t.sockets).toHaveLength(1);
    expect(report).not.toHaveProperty("observed");
  });

  it("isn't opened for a raw browser.connect() unless asked for", async () => {
    const t = setup();
    const connected = await t.browser.connect();
    expect(connected).not.toHaveProperty("observer");
    expect(t.sockets).toHaveLength(1);
    connected.cdp.disconnect();
  });

  it("opens alongside the model's socket", async () => {
    const t = setup();
    // Both upgrades are under way before the model's socket is used.
    const session = t.browser.session();
    await session.send({ method: "Target.getTargets" });
    expect(t.sockets).toHaveLength(2);
    expect(t.sockets[1].sent).toEqual([]);
    await session.close();
  });

  it("records where the model's tab went and what each document returned", async () => {
    const t = setup();
    const instance = await t.start();
    const { target, error, report } = await observed(t, [
      navigateActive("https://example.com/")
    ]);
    expect(error).toBeUndefined();

    expect(report?.observed).toEqual({
      available: true,
      tabs: [
        {
          targetId: target,
          initialUrl: "about:blank",
          navigations: [{ url: "https://example.com/" }],
          documents: [
            {
              url: "https://example.com/",
              status: 200,
              redirects: [
                { url: "https://example.com/?from=redirect", status: 302 }
              ]
            }
          ],
          dialogs: []
        }
      ]
    });
    expect(observerSent(t)).toEqual([
      "Target.attachToTarget",
      "Page.enable",
      "Network.enable",
      "Page.getFrameTree",
      // The flush before the record is read.
      "Page.getFrameTree"
    ]);
    expect(
      t.sockets[1].sent.find(({ method }) => method === "Network.enable")
        ?.params
    ).toEqual({
      maxPostDataSize: 0,
      maxTotalBufferSize: 0,
      maxResourceBufferSize: 0
    });
    expect(report?.notices).toEqual([]);
    // Both sockets are closed with the session.
    expect(t.sockets.every((socket) => socket.closed)).toBe(true);
    expect(instance.sockets.size).toBe(0);
  });

  it("holds the model's first command to a tab for at most 250 ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const t = setup();
      // A slow tab: the observer's enables get no reply in time.
      t.silentMethods.set(2, ["Page.enable", "Network.enable"]);
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      const session = t.browser.session();
      let firstDone = false;
      const first = call(session, evaluateActive).then((result) => {
        firstDone = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(249);
      expect(firstDone).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const target = evaluatedIn(await first);
      // Later commands don't wait.
      await call(session, evaluateActive);
      const closing = session.close();
      await vi.advanceTimersByTimeAsync(2_000);
      const report = await closing;
      warned.mockRestore();
      // Its setup timed out, but it answered at close: slow, not blocked.
      expect(tabsOf(report)[0].targetId).toBe(target);
      expect(tabsOf(report)[0]).not.toHaveProperty("blocked");
      expect(report?.notices).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts on the scope's tab before the model's first command", async () => {
    const t = setup();
    await t.run([evaluateActive]);
    const stored = t.activeTab();
    const session = t.browser.session();
    // Nothing attached "active" yet.
    await session.send({ method: "Target.getTargets" });
    await settle();
    const observerSocket = t.sockets[3];
    expect(observerSocket.sent[0]).toMatchObject({
      method: "Target.attachToTarget",
      params: { targetId: stored }
    });
    const report = await session.close();
    // The model never used the tab, so it isn't in the record.
    expect(tabsOf(report)).toEqual([]);
  });

  it("doesn't follow a target that isn't a page, nor call it blocked", async () => {
    const t = setup();
    const instance = await t.start();
    const worker = instance.addTab("https://example.com/sw.js");
    const tab = instance.tabs.find(({ targetId }) => targetId === worker);
    if (tab) tab.type = "service_worker";
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = t.browser.session();
    await session.attachToTarget({ targetId: worker });
    const report = await session.close();
    warned.mockRestore();
    expect(tabsOf(report)).toEqual([]);
    expect(report?.notices).toEqual([]);
    expect(observerSent(t)).toContain("Target.detachFromTarget");
  });

  it("keeps observing after the model disables Page and Network", async () => {
    const t = setup();
    const disable = (method: string): Call => [
      "send",
      { method, sessionId: "active" }
    ];
    const { report } = await observed(t, [
      ["send", { method: "Page.enable", sessionId: "active" }],
      disable("Page.disable"),
      disable("Network.disable"),
      navigateActive("https://example.com/")
    ]);
    expect(tabsOf(report)[0].navigations).toEqual([
      { url: "https://example.com/" }
    ]);
  });

  it("keeps its traffic out of the model's socket and debug log", async () => {
    const t = setup();
    const { results } = await observed(t, [
      navigateActive("https://example.com/"),
      ["getDebugLog", {}]
    ]);
    const modelMethods = t.sockets[0].sent.map(({ method }) => method);
    expect(modelMethods).not.toContain("Network.enable");
    expect(modelMethods).not.toContain("Page.enable");
    const log = JSON.stringify(results[1]);
    expect(log).not.toContain("Network.enable");
    expect(log).not.toContain("Network.requestWillBeSent");
  });

  it("follows a raw Target.attachToTarget but not the page's popups", async () => {
    const t = setup();
    const instance = await t.start();
    const other = instance.addTab("https://other.example/");
    const { report } = await observed(t, [
      openPopup,
      [
        "send",
        {
          method: "Target.attachToTarget",
          params: { targetId: other, flatten: true }
        }
      ]
    ]);
    expect(report?.newTabs).toHaveLength(1);
    const popup = report?.newTabs[0].targetId;
    const tabs = tabsOf(report);
    // The tab "active" opened, then the one attached raw; not the popup.
    expect(tabs).toHaveLength(2);
    expect(tabs[0].targetId).not.toBe(popup);
    expect(tabs[1]).toMatchObject({
      targetId: other,
      initialUrl: "https://other.example/"
    });
  });

  it("answers dialogs at once, records them, and tells the model", async () => {
    const t = setup();
    const session = t.browser.session();
    const target = evaluatedIn(await call(session, evaluateActive));
    const instance = t.instance();
    for (const type of ["alert", "confirm", "prompt", "beforeunload"]) {
      instance.emit(target, "Page.javascriptDialogOpening", {
        type,
        message: type === "alert" ? "x".repeat(300) : `${type}?`,
        hasBrowserHandler: true
      });
    }
    const report = await session.close();
    const answers = t.sockets[1].sent.filter(
      ({ method }) => method === "Page.handleJavaScriptDialog"
    );
    expect(answers.map(({ params }) => params)).toEqual([
      { accept: true },
      { accept: false },
      { accept: false },
      { accept: true }
    ]);
    expect(tabsOf(report)[0].dialogs).toEqual([
      { type: "alert", message: "x".repeat(200), accepted: true },
      { type: "confirm", message: "confirm?", accepted: false },
      { type: "prompt", message: "prompt?", accepted: false },
      { type: "beforeunload", message: "beforeunload?", accepted: true }
    ]);
    expect(report?.notices).toEqual([
      expect.stringContaining("opened an alert dialog"),
      'The page opened a confirm dialog ("confirm?"), and the host dismissed it, so confirm() returned false. To answer OK, set `window.confirm = () => true` in the page before the step that opens it.',
      'The page opened a prompt dialog ("prompt?"), and the host dismissed it, so prompt() returned null. To answer it, set `window.prompt = () => "<answer>"` in the page before the step that opens it.',
      'The page opened a beforeunload dialog ("beforeunload?"), and the host accepted it.'
    ]);
  });

  it("ignores events tagged with another connection's session id", async () => {
    const t = setup();
    const session = t.browser.session();
    await call(session, evaluateActive);
    // Browser Run tags Cloudflare.* events with every connection's ids.
    t.sockets[1].event({
      method: "Page.javascriptDialogOpening",
      params: { type: "alert", message: "elsewhere" },
      sessionId: "another-connections-session"
    });
    const report = await session.close();
    expect(observerSent(t)).not.toContain("Page.handleJavaScriptDialog");
    expect(tabsOf(report)[0].dialogs).toEqual([]);
  });

  it("reports a tab a dialog left blocked, and how to recover it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const t = setup();
      const instance = await t.start();
      const stuck = instance.addTab("https://stuck.example/");
      instance.blocked.add(stuck);
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      const session = t.browser.session();
      const attaching = session.attachToTarget({ targetId: stuck });
      await vi.advanceTimersByTimeAsync(250);
      await attaching;
      const closing = session.close();
      await vi.advanceTimersByTimeAsync(3_000);
      const report = await closing;
      warned.mockRestore();
      expect(tabsOf(report)[0]).toMatchObject({
        targetId: stuck,
        blocked: { url: "https://stuck.example/" }
      });
      expect(report?.notices).toEqual([
        `The tab ${stuck} (https://stuck.example/) isn't responding, probably because of a dialog that opened before the host could answer it, which can't be answered now. Its page commands time out until you send Page.reload to it or navigate it.`
      ]);
      // The observer didn't reload it: that's the model's call.
      expect(observerSent(t)).not.toContain("Page.reload");
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes on without the observer when it can't connect, and says so", async () => {
    const t = setup();
    t.upgradeOverrides.set(
      2,
      async () => new Response("unavailable", { status: 503 })
    );
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { error, results, report } = await t.run([evaluateActive]);
    warned.mockRestore();
    expect(error).toBeUndefined();
    expect(evaluatedIn(results[0])).toBe(t.activeTab());
    expect(report?.observed).toEqual({
      available: false,
      reason: expect.stringContaining("couldn't connect")
    });
  });

  it("goes on without the observer when it doesn't connect within 2 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const t = setup();
      t.upgradeOverrides.set(2, () => new Promise<Response>(() => {}));
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      const running = t.run([evaluateActive]);
      await vi.advanceTimersByTimeAsync(2_000);
      const { error, report } = await running;
      warned.mockRestore();
      expect(error).toBeUndefined();
      expect(report?.observed).toEqual({
        available: false,
        reason: "the observer didn't connect within 2000ms"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a main document that failed to load", async () => {
    const t = setup();
    const { report } = await observed(t, [
      navigateActive("https://refused.example/")
    ]);
    expect(tabsOf(report)[0].documents).toEqual([
      {
        url: "https://refused.example/",
        redirects: [],
        error: "net::ERR_CONNECTION_REFUSED"
      }
    ]);
    expect(tabsOf(report)[0].navigations).toEqual([]);
  });

  it("records a same-document navigation", async () => {
    const t = setup();
    const { report } = await observed(t, [
      [
        "send",
        {
          method: "Runtime.evaluate",
          params: {
            expression:
              'history.pushState(null, "", "https://example.com/next")'
          },
          sessionId: "active"
        }
      ]
    ]);
    expect(tabsOf(report)[0].navigations).toEqual([
      { url: "https://example.com/next", sameDocument: true }
    ]);
  });

  it("tells the model to reload a blocked tab when its command times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const t = setup();
      const instance = await t.start();
      const stuck = instance.addTab("https://stuck.example/");
      instance.blocked.add(stuck);
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      const session = t.browser.session();
      const attaching = session.attachToTarget({ targetId: stuck });
      await vi.advanceTimersByTimeAsync(250);
      const { sessionId } = await attaching;
      // The observer's setup times out, and it finds the tab blocked.
      await vi.advanceTimersByTimeAsync(1_000);
      const sending = session
        .send({
          method: "Runtime.evaluate",
          params: { expression: "1" },
          sessionId,
          timeoutMs: 500
        })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(500);
      const error = String(await sending);
      expect(error).toContain("CDP command timed out after 500ms");
      expect(error).toContain("Reload or navigate this tab");
      const closing = session.close();
      await vi.advanceTimersByTimeAsync(3_000);
      await closing;
      warned.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a plain timeout alone in a tab that isn't blocked", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const t = setup();
      t.silentMethods.set(1, ["Runtime.evaluate"]);
      const session = t.browser.session();
      const sending = call(session, [
        "send",
        {
          method: "Runtime.evaluate",
          params: { expression: "1" },
          sessionId: "active",
          timeoutMs: 500
        }
      ]).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      const error = String(await sending);
      expect(error).toContain("CDP command timed out after 500ms");
      expect(error).not.toContain("Reload");
      const closing = session.close();
      await vi.advanceTimersByTimeAsync(1_000);
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BrowserSession observer sockets", () => {
  /** Let a socket that arrives late be disconnected. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("closes the first observer when connect retries on a new browser", async () => {
    const t = setup();
    await t.start();
    // The stored browser is gone when the model's socket upgrades.
    t.upgradeOverrides.set(1, async () => new Response(null, { status: 410 }));
    const { error, report } = await t.run([evaluateActive]);
    expect(error).toBeUndefined();
    expect(report?.observed).toMatchObject({ available: true });
    // The first observer (to the gone browser), then the new browser's two.
    expect(t.sockets).toHaveLength(3);
    const replacement = t.instances.get("session-2");
    expect(t.sockets[1].instance).toBe(replacement);
    expect(t.sockets[2].instance).toBe(replacement);
    expect(t.sockets.every((socket) => socket.closed)).toBe(true);
  });

  it("closes an observer socket that arrives after the 2 s limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const t = setup();
      let release = () => {};
      t.upgradeOverrides.set(
        2,
        (upgrade) =>
          new Promise<Response>((resolve) => {
            release = () => resolve(upgrade());
          })
      );
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      const running = t.run([evaluateActive]);
      await vi.advanceTimersByTimeAsync(2_000);
      const { report } = await running;
      warned.mockRestore();
      expect(report?.observed).toMatchObject({ available: false });
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.sockets).toHaveLength(2);
      expect(t.sockets.every((socket) => socket.closed)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes an observer socket that arrives while the session closes", async () => {
    const t = setup();
    let release = () => {};
    t.upgradeOverrides.set(
      2,
      (upgrade) =>
        new Promise<Response>((resolve) => {
          release = () => resolve(upgrade());
        })
    );
    const session = t.browser.session();
    await session.send({ method: "Target.getTargets" });
    const closing = session.close();
    release();
    await closing;
    await settle();
    expect(t.sockets).toHaveLength(2);
    expect(t.sockets.every((socket) => socket.closed)).toBe(true);
  });

  it("closes the observer when listing the tabs fails", async () => {
    const t = setup();
    t.failingMethods.set(1, ["Target.getTargets"]);
    const session = t.browser.session();
    await expect(
      session.send({ method: "Target.getTargets" })
    ).rejects.toThrow();
    await session.close();
    await settle();
    expect(t.sockets).toHaveLength(2);
    expect(t.sockets.every((socket) => socket.closed)).toBe(true);
  });
});

describe("BrowserSession locks", () => {
  /** Whether `promise` has settled, after letting pending work run. */
  async function settled(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    void promise.then(
      () => (done = true),
      () => (done = true)
    );
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    return done;
  }

  it("waits at the first call until the scope's lock is free", async () => {
    const t = setup();
    const first = t.browser.session({ scope: "a", lock: true });
    await call(first, createTabCall);
    const second = t.browser.session({ scope: "a", lock: true });
    const waiting = call(second, evaluateActive);
    expect(await settled(waiting)).toBe(false);

    await first.close();
    // It lands in the tab the first session opened and left active.
    expect(evaluatedIn(await waiting)).toBe("target-2");
    await second.close();
  });

  it("counts the time it waited, across a given-up wait and a retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = setup();
      vi.setSystemTime(1_000);
      const holder = t.browser.session({ lock: true });
      await holder.lock();
      const waiter = t.browser.session({ lock: true });
      const waiting = waiter.lock();
      expect(await settled(waiting)).toBe(false);
      vi.setSystemTime(1_250);
      await holder.close();
      await waiting;
      expect(holder.waitedForLockMs).toBe(0);
      expect(waiter.waitedForLockMs).toBe(250);

      // Waiting for the lock again later counts from the new wait.
      const next = t.browser.session({ lock: true });
      const controller = new AbortController();
      const givenUp = next.lock({ signal: controller.signal });
      vi.setSystemTime(1_350);
      controller.abort(new Error("deadline"));
      await expect(givenUp).rejects.toThrow("deadline");
      expect(next.waitedForLockMs).toBe(100);
      const retry = next.lock();
      vi.setSystemTime(1_650);
      await waiter.close();
      await retry;
      expect(next.waitedForLockMs).toBe(400);

      // Calls once the lock is held add nothing.
      vi.setSystemTime(5_000);
      await next.lock();
      await call(next, evaluateActive);
      expect(next.waitedForLockMs).toBe(400);
      await next.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes in order, and leaves other scopes and plain sessions alone", async () => {
    const t = setup();
    await t.start();
    const order: string[] = [];
    const sessions = ["one", "two", "three"].map((name) => {
      const session = t.browser.session({ scope: "a", lock: true });
      const done = session.lock().then(() => order.push(name));
      return { session, done };
    });
    await settled(sessions[0].done);
    expect(order).toEqual(["one"]);

    // Another scope, and a session that doesn't lock, don't wait.
    const other = t.browser.session({ scope: "b", lock: true });
    expect(await settled(other.lock())).toBe(true);
    const plain = t.browser.session({ scope: "a" });
    expect(await settled(call(plain, evaluateActive))).toBe(true);
    await Promise.all([other.close(), plain.close()]);

    for (const { session, done } of sessions) {
      await done;
      await session.close();
    }
    expect(order).toEqual(["one", "two", "three"]);
  });

  it("takes the lock once however often it's asked", async () => {
    const t = setup();
    const session = t.browser.session({ lock: true });
    await session.lock();
    await session.lock();
    await call(session, evaluateActive);
    await session.close();
    // Free again: a new session doesn't wait.
    const next = t.browser.session({ lock: true });
    expect(await settled(next.lock())).toBe(true);
    await next.close();
  });

  it("leaves the queue at once when the wait is aborted", async () => {
    const t = setup();
    const holder = t.browser.session({ lock: true });
    await holder.lock();
    const quitter = t.browser.session({ lock: true });
    const controller = new AbortController();
    const quitting = quitter.lock({ signal: controller.signal });
    const behind = t.browser.session({ lock: true });
    const behindLock = behind.lock();

    const reason = new Error("gave up waiting for the browser");
    controller.abort(reason);
    await expect(quitting).rejects.toBe(reason);

    await holder.close();
    // Not stuck behind the session that gave up.
    expect(await settled(behindLock)).toBe(true);
    await behind.close();
    // The quitter can wait again, and gets the lock now it's free.
    await quitter.lock();
    await quitter.close();
  });

  it("rejects at once with an already-aborted signal, leaving no queue", async () => {
    const t = setup();
    const reason = new Error("too late");
    for (let i = 0; i < 10; i++) {
      const session = t.browser.session({ scope: `s${i}`, lock: true });
      await expect(
        session.lock({ signal: AbortSignal.abort(reason) })
      ).rejects.toBe(reason);
      await session.close();
    }
    expect(lockedScopes(t.browser)).toEqual([]);
  });

  it("lets a later already-aborted signal reject only its own call", async () => {
    const t = setup();
    const holder = t.browser.session({ lock: true });
    await holder.lock();
    const waiter = t.browser.session({ lock: true });
    const first = waiter.lock();
    const reason = new Error("too late");
    await expect(
      waiter.lock({ signal: AbortSignal.abort(reason) })
    ).rejects.toBe(reason);
    expect(await settled(first)).toBe(false);
    await holder.close();
    await first;
    await waiter.close();
    expect(lockedScopes(t.browser)).toEqual([]);
  });

  it("lets a later signal bound its own wait while the others keep waiting", async () => {
    const t = setup();
    const holder = t.browser.session({ lock: true });
    await holder.lock();
    const waiter = t.browser.session({ lock: true });
    const keep = new AbortController();
    const quit = new AbortController();
    const kept = waiter.lock({ signal: keep.signal });
    const quitting = waiter.lock({ signal: quit.signal });
    // The wait a function call makes never gives up either.
    const working = call(waiter, evaluateActive);
    const bounded = new AbortController();
    const boundedLock = waiter.lock({ signal: bounded.signal });

    const reason = new Error("deadline");
    quit.abort(reason);
    await expect(quitting).rejects.toBe(reason);
    bounded.abort(reason);
    await expect(boundedLock).rejects.toBe(reason);
    keep.abort(reason);
    await expect(kept).rejects.toBe(reason);

    // Still queued behind the holder, for the function call.
    expect(await settled(working)).toBe(false);
    const behind = t.browser.session({ lock: true });
    const behindLock = behind.lock();
    await holder.close();
    await working;
    expect(await settled(behindLock)).toBe(false);
    await waiter.close();
    await behindLock;
    await behind.close();
  });

  it("leaves the queue once every call has given up, and cleans up", async () => {
    const t = setup();
    const holder = t.browser.session({ lock: true });
    await holder.lock();
    const waiter = t.browser.session({ lock: true });
    const one = new AbortController();
    const two = new AbortController();
    const first = waiter.lock({ signal: one.signal });
    const second = waiter.lock({ signal: two.signal });
    const behind = t.browser.session({ lock: true });
    const behindLock = behind.lock();

    one.abort(new Error("one"));
    two.abort(new Error("two"));
    await expect(first).rejects.toThrow("one");
    await expect(second).rejects.toThrow("two");
    await holder.close();
    // Not stuck behind the session whose calls all gave up.
    expect(await settled(behindLock)).toBe(true);
    await behind.close();
    await waiter.close();
    expect(lockedScopes(t.browser)).toEqual([]);

    // A call that gets the lock stops listening to its signal.
    const third = t.browser.session({ lock: true });
    const signal = new AbortController().signal;
    const unlistened = vi.spyOn(signal, "removeEventListener");
    await third.lock({ signal });
    expect(unlistened).toHaveBeenCalledWith("abort", expect.any(Function));
    await third.close();
    expect(lockedScopes(t.browser)).toEqual([]);
  });

  it("stops waiting when the session closes", async () => {
    const t = setup();
    const holder = t.browser.session({ lock: true });
    await holder.lock();
    const closer = t.browser.session({ lock: true });
    const waiting = call(closer, evaluateActive);
    const behind = t.browser.session({ lock: true });
    const behindLock = behind.lock();

    expect(await closer.close()).toBeUndefined();
    await expect(waiting).rejects.toThrow("closed");
    await holder.close();
    expect(await settled(behindLock)).toBe(true);
    await behind.close();
  });

  it("releases the lock when the session closes without connecting", async () => {
    const t = setup();
    const idle = t.browser.session({ lock: true });
    await idle.lock();
    expect(await idle.close()).toBeUndefined();
    const next = t.browser.session({ lock: true });
    expect(await settled(next.lock())).toBe(true);
    await next.close();
  });

  it('shares a queue between the default scope and "shared"', async () => {
    const t = setup();
    const unscoped = t.browser.session({ lock: true });
    await unscoped.lock();
    const shared = t.browser.session({ scope: "shared", lock: true });
    expect(await settled(shared.lock())).toBe(false);
    await unscoped.close();
    await shared.lock();
    await shared.close();
  });

  it("locks per source, so custom sources work", async () => {
    const t = setup();
    const source: BrowserSource = {
      name: "custom",
      connect: (options) => t.browser.connect(options)
    };
    const first = new BrowserSession(source, { lock: true });
    await call(first, evaluateActive);
    const second = new BrowserSession(source, { lock: true });
    const waiting = call(second, evaluateActive);
    // The Browser itself is another source, with its own queue.
    const direct = t.browser.session({ lock: true });
    expect(await settled(direct.lock())).toBe(true);
    await direct.close();

    expect(await settled(waiting)).toBe(false);
    await first.close();
    expect(evaluatedIn(await waiting)).toBe("target-2");
    await second.close();
  });

  it("holds the hosts functions to the lock and the session's lifetime", async () => {
    const t = setup();
    const assigned: string[] = [];
    const hosts: BrowserInternalHosts = {
      describe: () => [
        { host: "a.internal", url: "http://a.internal/", assignable: true }
      ],
      list: async () => [],
      assign: async (host) => {
        assigned.push(host);
        return { url: `http://${host}/` };
      },
      clear: async () => true
    };
    const source: BrowserSource = {
      name: "hosts",
      connect: (options) => t.browser.connect(options),
      internalHosts: hosts
    };
    const holder = new BrowserSession(source, { scope: "a", lock: true });
    await holder.lock();
    const session = new BrowserSession(source, { scope: "a", lock: true });
    const { assignHost, clearHost, listHosts } = session.functions;

    // Bad input fails before the wait.
    await expect(assignHost({})).rejects.toThrow("needs { host }");
    await expect(assignHost({ host: "a.internal" })).rejects.toThrow(
      "needs a target"
    );
    const assigning = assignHost({ host: "a.internal", target: {} });
    expect(await settled(assigning)).toBe(false);
    expect(assigned).toEqual([]);
    await holder.close();
    await assigning;
    expect(assigned).toEqual(["a.internal"]);

    await session.close();
    const connect = vi.spyOn(source, "connect");
    const list = vi.spyOn(hosts, "list");
    await expect(
      assignHost({ host: "a.internal", target: {} })
    ).rejects.toThrow("closed");
    await expect(clearHost({ host: "a.internal" })).rejects.toThrow("closed");
    await expect(listHosts({})).rejects.toThrow("closed");
    expect(assigned).toEqual(["a.internal"]);
    expect(list).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("closes the hosts functions of a session that doesn't lock", async () => {
    const t = setup();
    const clear = vi.fn(async () => true);
    const source: BrowserSource = {
      name: "hosts",
      connect: (options) => t.browser.connect(options),
      internalHosts: {
        describe: () => [
          { host: "a.internal", url: "http://a.internal/", assignable: true }
        ],
        list: async () => [],
        assign: async (host) => ({ url: `http://${host}/` }),
        clear
      }
    };
    const session = new BrowserSession(source);
    expect(await session.functions.clearHost({ host: "a.internal" })).toEqual({
      cleared: true
    });
    await session.close();
    await expect(
      session.functions.clearHost({ host: "a.internal" })
    ).rejects.toThrow("closed");
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("refuses lock() on a session opened without lock", async () => {
    const t = setup();
    const session = t.browser.session();
    await expect(session.lock()).rejects.toThrow("lock: true");
    expect(session.waitedForLockMs).toBe(0);
    await session.close();
  });
});

describe("conversationScope", () => {
  it("names a conversation's scope", () => {
    expect(conversationScope("2")).toBe("conversation:2");
    expect(conversationScope("abc")).toBe("conversation:abc");
  });

  it("throws on a missing id instead of sharing one scope", () => {
    expect(() => conversationScope("")).toThrow("conversation id");
    // SAFETY: Simulates a missing metadata key at runtime.
    expect(() => conversationScope(undefined as unknown as string)).toThrow(
      "conversation id"
    );
  });
});
