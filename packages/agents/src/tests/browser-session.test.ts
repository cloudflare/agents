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
  type: "page";
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
        // Page-scoped commands without a session fail like Chrome does.
        if (!command.method.startsWith("Target.") && !command.sessionId) {
          return {
            error: {
              code: -32601,
              message: `'${command.method}' wasn't found`
            }
          };
        }
        if (command.method === "Runtime.evaluate" && command.sessionId) {
          // Simulate a page opening a popup.
          if (params.expression === "openPopup()") {
            this.addTab(
              "https://popup.example/",
              this.attached.get(command.sessionId)
            );
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
  /** CDP sessions attached over this socket; Chrome drops them on close. */
  #sessions = new Set<string>();
  #listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly instance: FakeBrowserInstance) {}
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
    queueMicrotask(() => {
      const reply = this.instance.handle(command);
      const attached = (reply.result as { sessionId?: unknown } | undefined)
        ?.sessionId;
      if (command.method === "Target.attachToTarget") {
        this.#sessions.add(String(attached));
      }
      this.#emit("message", {
        data: JSON.stringify({ id: command.id, ...reply })
      });
    });
  }
  close(): void {
    this.closed = true;
    for (const sessionId of this.#sessions) {
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

  const browser = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input);
      const method = init?.method ?? "GET";
      const sessionId = url.match(/\/browser\/(session-[^/?]+)/)?.[1];
      if (new Headers(init?.headers).get("Upgrade") === "websocket") {
        const instance = sessionId ? instances.get(sessionId) : undefined;
        if (!instance) return new Response(null, { status: 410 });
        const socket = new FakeSocket(instance);
        sockets.push(socket);
        const response = new Response(null);
        Object.defineProperty(response, "webSocket", { value: socket });
        return response;
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

  return { browser, instances, sockets };
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

function setup() {
  const fake = createFakeBrowser();
  const store = new MemorySessionStore();
  const browser = new Browser({
    provider: browserRun(fake.browser),
    name: "work",
    store
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
      notices: []
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

    expect(t.sockets).toHaveLength(2);
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

  it("shares one connection between concurrent first calls", async () => {
    const t = setup();
    const session = t.browser.session();
    await Promise.all([
      call(session, evaluateActive),
      session.send({ method: "Target.getTargets" })
    ]);
    await session.close();
    expect(t.sockets).toHaveLength(1);
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
