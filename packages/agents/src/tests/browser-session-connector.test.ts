import { describe, expect, it } from "vitest";
import { BrowserSessionConnector } from "../browser/session-connector";
import {
  NamedBrowserSessions,
  namedBrowserSessionKey
} from "../browser/session-core";
import type {
  BrowserSessionLock,
  BrowserSessionStore,
  StoredBrowserSession
} from "../browser/session-manager";

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

  addTab(url = "about:blank"): string {
    const targetId = `target-${++this.#nextTarget}`;
    this.tabs.push({ targetId, type: "page", url });
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
      default:
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
            this.addTab("https://popup.example/");
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
  #listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly instance: FakeBrowserInstance) {}
  accept(): void {}
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(fn);
    this.#listeners.set(type, list);
  }
  send(data: string): void {
    const command = JSON.parse(data) as SentCommand;
    this.sent.push(command);
    queueMicrotask(() => {
      const reply = this.instance.handle(command);
      this.#emit("message", {
        data: JSON.stringify({ id: command.id, ...reply })
      });
    });
  }
  close(): void {
    this.closed = true;
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
  const sessions = new NamedBrowserSessions({
    browser: fake.browser,
    store
  });
  const connector = new BrowserSessionConnector(fakeCtx, {
    sessions,
    session: "work"
  });
  let executions = 0;

  /** Run `calls` as one execution (one pass) and return its report. */
  async function run(
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
    await connector.onPassEnd(executionId, error ? "error" : "completed");
    return { results, error, report: connector.takeReport(executionId) };
  }

  function stored() {
    return store.sessions.get(namedBrowserSessionKey("work"));
  }
  function instance() {
    return fake.instances.get(stored()!.sessionId)!;
  }
  /** Create the browser up front, so tests can arrange its tabs. */
  async function start() {
    await sessions.resolve("work");
    return instance();
  }

  return {
    ...fake,
    store,
    sessions,
    connector,
    run,
    stored,
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
  });

  it('routes "active" to the only open tab and remembers it', async () => {
    const t = setup();
    const { results, report } = await t.run([evaluateActive]);

    expect(evaluatedIn(results[0])).toBe("target-1");
    expect(report).toEqual({ restarted: false, newTabs: [] });
    expect(t.stored()?.activeTargetId).toBe("target-1");
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
    expect(evaluatedIn(results[0])).toBe("target-1");
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

  it("falls back to the first tab when several are open and none is stored", async () => {
    const t = setup();
    await t.run([["send", { method: "Browser.getVersion" }]]);
    t.instance().addTab("https://second.example/");

    const { results } = await t.run([evaluateActive]);
    expect(evaluatedIn(results[0])).toBe("target-1");
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
    expect(t.stored()?.activeTargetId).toBe("target-2");
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
    expect(t.stored()?.activeTargetId).toBe("target-2");

    // One attach per target per socket.
    const attaches = t.sockets[0].sent.filter(
      (command) => command.method === "Target.attachToTarget"
    );
    expect(attaches).toHaveLength(1);
  });

  it("reports tabs the page opened as newTabs without switching to them", async () => {
    const t = setup();
    const { report } = await t.run([
      [
        "send",
        {
          method: "Runtime.evaluate",
          params: { expression: "openPopup()" },
          sessionId: "active"
        }
      ]
    ]);
    expect(report?.newTabs).toEqual([
      { targetId: "target-2", url: "https://popup.example/" }
    ]);
    expect(t.stored()?.activeTargetId).toBe("target-1");
  });

  it("picks a tab afresh after the active tab is closed", async () => {
    const t = setup();
    (await t.start()).addTab("https://second.example/");
    const { results } = await t.run([
      evaluateActive,
      [
        "send",
        { method: "Target.closeTarget", params: { targetId: "target-1" } }
      ],
      evaluateActive
    ]);
    expect(evaluatedIn(results[0])).toBe("target-1");
    expect(evaluatedIn(results[2])).toBe("target-2");
    expect(t.stored()?.activeTargetId).toBe("target-2");
  });

  it("forgets a stored tab that was closed outside the agent", async () => {
    const t = setup();
    await t.run([evaluateActive]);
    t.instance().tabs = [];
    await t.run([["send", { method: "Browser.getVersion" }]]);
    expect(t.stored()?.activeTargetId).toBeUndefined();
  });

  it("reports restarted when the browser was replaced, with no stale tab", async () => {
    const t = setup();
    await t.run([evaluateActive]);
    // The platform reclaims the browser between executions.
    t.instances.clear();

    const { results, report } = await t.run([evaluateActive]);
    expect(report?.restarted).toBe(true);
    expect(t.stored()?.sessionId).toBe("session-2");
    expect(evaluatedIn(results[0])).toBe("target-1");
    expect(t.stored()?.activeTargetId).toBe("target-1");
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
