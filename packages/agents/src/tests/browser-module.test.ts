import { describe, expect, it } from "vitest";
import { Browser, namedBrowserSessionKey } from "../browser/browser";
import { browserRun } from "../browser/providers/browser-run";
import {
  createBrowserModule,
  type BrowserModuleCallContext
} from "../browser/tools/computer";
import { MemorySessionStore, createFakeBrowser } from "./browser-fakes";

function setup() {
  const fake = createFakeBrowser();
  const store = new MemorySessionStore();
  const browser = new Browser({
    provider: browserRun(fake.browser),
    name: "work",
    store
  });
  const module = createBrowserModule({ browser });
  const functions = module(undefined);
  let runs = 0;

  /**
   * Run `calls` as one execution the way the JavaScript backend does: every
   * call gets the same execution id, and deferred functions run last first
   * once the code is done.
   */
  async function run(
    calls: Array<[name: keyof typeof functions, args?: unknown]>
  ) {
    const logs: string[] = [];
    const deferred: Array<() => unknown> = [];
    const context: BrowserModuleCallContext = {
      executionId: `run-${++runs}`,
      log: (text) => logs.push(text),
      defer: (fn) => deferred.push(fn)
    };
    const results: unknown[] = [];
    let error: unknown;
    try {
      for (const [name, args] of calls) {
        results.push(
          await functions[name](args === undefined ? [] : [args], context)
        );
      }
    } catch (caught) {
      error = caught;
    }
    while (deferred.length > 0) await deferred.pop()?.();
    return { results, error, logs, deferred: deferred.length };
  }

  function stored() {
    return store.sessions.get(namedBrowserSessionKey("work"));
  }
  function activeTab(scope = "shared") {
    return store.sessions.get(`browser:scope:4:work:${scope}`)?.activeTargetId;
  }
  function instance() {
    return fake.instances.get(stored()!.sessionId)!;
  }

  return { ...fake, browser, module, functions, run, activeTab, instance };
}

describe("ws:browser module", () => {
  it("exports the browser calls and describes them", () => {
    const t = setup();
    expect(Object.keys(t.functions).sort()).toEqual([
      "attachToTarget",
      "clearDebugLog",
      "getDebugLog",
      "send",
      "spec"
    ]);
    expect(t.module.description).toContain("send({ method");
    expect(t.module.description).toContain("standard error");
    expect(t.module.description).not.toContain("cdp.");
  });

  it("saves the active tab and closes the socket when the run ends", async () => {
    const t = setup();
    const { results, error, logs } = await t.run([
      [
        "send",
        { method: "Target.createTarget", params: { url: "about:blank" } }
      ],
      [
        "send",
        {
          method: "Runtime.evaluate",
          params: { expression: "1" },
          sessionId: "active"
        }
      ]
    ]);
    expect(error).toBeUndefined();
    expect(results[0]).toEqual({ targetId: "target-2" });
    expect(t.activeTab()).toBe("target-2");
    expect(t.sockets.every((socket) => socket.closed)).toBe(true);
    expect(logs).toEqual([]);

    // The next run lands in the same tab.
    const next = await t.run([
      [
        "send",
        {
          method: "Runtime.evaluate",
          params: { expression: "1" },
          sessionId: "active"
        }
      ]
    ]);
    expect(next.results[0]).toEqual({ result: { value: "target-2" } });
  });

  it("writes tabs the page opened to standard error", async () => {
    const t = setup();
    const { logs } = await t.run([
      [
        "send",
        { method: "Target.createTarget", params: { url: "about:blank" } }
      ],
      [
        "send",
        {
          method: "Runtime.evaluate",
          params: { expression: "openPopup()" },
          sessionId: "active"
        }
      ]
    ]);
    expect(logs).toEqual([
      'New tabs opened by the page: [{"targetId":"target-3","url":"https://popup.example/"}]'
    ]);
  });

  it("says so when the browser was replaced", async () => {
    const t = setup();
    await t.run([["send", { method: "Target.getTargets" }]]);
    t.instances.clear();
    const { logs, error } = await t.run([
      ["send", { method: "Target.getTargets" }]
    ]);
    expect(error).toBeUndefined();
    expect(logs).toEqual([
      expect.stringContaining("The browser was restarted before this run")
    ]);
  });

  it("refuses bad arguments with what to fix", async () => {
    const t = setup();
    const { error } = await t.run([["send", { params: {} }]]);
    expect(String(error)).toContain("Invalid arguments for cdp.send");
  });

  it("refuses to close the browser", async () => {
    const t = setup();
    const { error } = await t.run([["send", { method: "Browser.close" }]]);
    expect(String(error)).toContain("Browser.close is not available");
  });
});
