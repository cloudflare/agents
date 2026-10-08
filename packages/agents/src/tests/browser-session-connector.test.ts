import { describe, expect, it, vi } from "vitest";
import { BrowserSessionConnector } from "../browser/session-connector";
import {
  Browser,
  browserRun,
  MAX_BROWSER_SCOPES,
  namedBrowserSessionKey
} from "../browser/browser";
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
              commands: [{ name: "navigate" }],
              events: [{ name: "loadEventFired" }]
            }
          ]
        });
      }
      return new Response(null, { status: 204 });
    }
  };

  return { browser, instances, sockets };
}

const fakeCtx = {} as ExecutionContext;

function setup() {
  const fake = createFakeBrowser();
  const store = new MemorySessionStore();
  const browser = new Browser({
    provider: browserRun(fake.browser),
    name: "work",
    store
  });
  const connector = new BrowserSessionConnector(fakeCtx, { browser });
  let executions = 0;

  /** Run `calls` as one pass of `executionId`, without taking its report. */
  async function pass(
    executionId: string,
    calls: Array<[tool: string, args: Record<string, unknown>]>
  ) {
    const results: unknown[] = [];
    for (const [tool, args] of calls) {
      results.push(await connector.executeTool(tool, args, { executionId }));
    }
    await connector.onPassEnd(executionId);
    return results;
  }

  /** Run `calls` as one execution (one pass) and return its report. */
  function run(calls: Array<[tool: string, args: Record<string, unknown>]>) {
    return runWith(connector, calls);
  }

  /** A connector for another scope of the same browser. */
  function scoped(scope: string) {
    const other = new BrowserSessionConnector(fakeCtx, { browser, scope });
    return {
      connector: other,
      run: (calls: Array<[tool: string, args: Record<string, unknown>]>) =>
        runWith(other, calls)
    };
  }

  async function runWith(
    connector: BrowserSessionConnector,
    calls: Array<[tool: string, args: Record<string, unknown>]>
  ) {
    const executionId = `exec-${++executions}`;
    const results: unknown[] = [];
    let error: unknown;
    try {
      for (const [tool, args] of calls) {
        results.push(await connector.executeTool(tool, args, { executionId }));
      }
    } catch (caught) {
      error = caught;
    }
    await connector.onPassEnd(executionId);
    return { results, error, report: connector.takeReport(executionId) };
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
    connector,
    pass,
    run,
    scoped,
    stored,
    activeTab,
    instance,
    start
  };
}

const evaluateActive: [string, Record<string, unknown>] = [
  "send",
  {
    method: "Runtime.evaluate",
    params: { expression: "1" },
    sessionId: "active"
  }
];

/** Make the active page open a popup tab. */
const openPopup: [string, Record<string, unknown>] = [
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

describe("BrowserSessionConnector", () => {
  it("exposes cdp without any session-management tools", async () => {
    const { connector } = setup();
    expect(connector.name()).toBe("cdp");
    const description = await connector.describe();
    expect(Object.keys(description.descriptors).sort()).toEqual([
      "attachToTarget",
      "clearDebugLog",
      "getDebugLog",
      "send",
      "spec"
    ]);
    expect(description.instructions).toContain('sessionId: "active"');
    expect(description.instructions).toContain("restarted: true");
  });

  it('opens a tab of its own for "active" and remembers it', async () => {
    const t = setup();
    const { results, report } = await t.run([evaluateActive]);

    // Not Browser Run's initial blank tab (target-1): it might be anyone's.
    expect(evaluatedIn(results[0])).toBe("target-2");
    expect(report).toEqual({
      restarted: false,
      newTabs: [],
      tabClosed: false,
      tabShared: false
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

  it("drops the socket at pass end but keeps the browser", async () => {
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
    // A tab the connector opened for the agent is not a page-opened tab.
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
    // Both executions connect before either creates a tab.
    await t.connector.executeTool(evaluateActive[0], evaluateActive[1], {
      executionId: "exec-a"
    });
    await t.pass("exec-b", [
      ["send", { method: "Target.createTarget", params: { url: "" } }]
    ]);
    await t.connector.onPassEnd("exec-a");

    expect(t.connector.takeReport("exec-a")?.newTabs).toEqual([]);
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

  it("keeps popups from earlier passes of a resumed execution", async () => {
    const t = setup();
    // The first pass opens a popup, then pauses for approval.
    await t.pass("exec-resumed", [openPopup]);
    await t.pass("exec-resumed", [evaluateActive]);

    expect(t.connector.takeReport("exec-resumed")?.newTabs).toEqual([
      { targetId: "target-3", url: "https://popup.example/" }
    ]);
  });

  it("drops a popup that closed before the execution ended", async () => {
    const t = setup();
    await t.pass("exec-resumed", [openPopup]);
    await t.pass("exec-resumed", [
      [
        "send",
        { method: "Target.closeTarget", params: { targetId: "target-3" } }
      ]
    ]);

    expect(t.connector.takeReport("exec-resumed")?.newTabs).toEqual([]);
  });

  it("saves a tab switch even if the socket drops before the pass ends", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = setup();
      (await t.start()).addTab("https://other.example/");
      await t.connector.executeTool(
        "attachToTarget",
        { targetId: "target-2" },
        { executionId: "exec-drop" }
      );
      // Browser Run drops the socket; the browser itself lives on.
      t.sockets[0].close();
      await t.connector.onPassEnd("exec-drop");

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

  it("shares one connection between concurrent first calls", async () => {
    const t = setup();
    const executionId = "exec-parallel";
    await Promise.all([
      t.connector.executeTool(evaluateActive[0], evaluateActive[1], {
        executionId
      }),
      t.connector.executeTool(
        "send",
        { method: "Target.getTargets" },
        { executionId }
      )
    ]);
    await t.connector.onPassEnd(executionId);
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

  it("reports nothing for an execution that never touched the browser", async () => {
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
    expect(String(error)).toContain("Invalid arguments for cdp.send");
    expect(t.sockets).toHaveLength(0);
  });

  it("reads the protocol spec from the session's own browser", async () => {
    const t = setup();
    const { results } = await t.run([["spec", {}]]);
    const spec = results[0] as { domains: Array<{ name: string }> };
    expect(spec.domains.map((domain) => domain.name)).toEqual(["Page"]);
  });
});

describe("BrowserSessionConnector scopes", () => {
  const createTab: [string, Record<string, unknown>] = [
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
    // A opens a blank tab, and B starts before A's pass ends.
    await a.connector.executeTool("send", createTab[1], {
      executionId: "a-1"
    });
    const { results } = await b.run([evaluateActive]);
    await a.connector.onPassEnd("a-1");

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
    // A's pass is open while B's page opens a popup.
    await a.connector.executeTool("send", evaluateActive[1], {
      executionId: "a-1"
    });
    const fromB = await b.run([openPopup]);
    await a.connector.onPassEnd("a-1");

    expect(a.connector.takeReport("a-1")?.newTabs).toEqual([]);
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
