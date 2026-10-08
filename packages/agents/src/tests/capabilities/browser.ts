import { DurableObject } from "cloudflare:workers";
import type { BrowserBinding } from "../../browser/browser-run";
import { Browser, browserRun } from "../../browser/browser";
import { Lifecycle } from "../../lifecycle";

/** One request the fake Browser Run binding served, in arrival order. */
export interface RecordedBrowserRequest {
  url: string;
  method: string;
  upgrade: boolean;
  /** Parsed JSON request body, when the request carried one. */
  body?: unknown;
}

/**
 * A CDP WebSocket stub: acks accept/close, and answers the handful of CDP
 * commands the browser tool issues. Each session starts with one blank tab,
 * like Browser Run; `Target.createTarget` adds more, shared by every socket
 * on the session.
 */
class FakeBrowserSocket {
  #listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(
    readonly sessionId: string,
    readonly tabs: string[],
    readonly events: string[]
  ) {}
  accept(): void {}
  send(data: string): void {
    const { id, method, params, sessionId } = JSON.parse(data) as {
      id: number;
      method: string;
      params?: { fakeBytes?: number; expression?: string };
      sessionId?: string;
    };
    const first = `target-${this.sessionId}`;
    const evaluatedIn = sessionId?.replace(/^cdp-/, "") ?? first;
    // `wait:<ms>` (not real JavaScript) delays the reply, so tests can
    // tell overlapping runs from queued ones.
    const wait = Number(params?.expression?.match(/^wait:(\d+)$/)?.[1] ?? 0);
    const result =
      method === "Target.getTargets"
        ? {
            targetInfos: [first, ...this.tabs].map((targetId) => ({
              targetId,
              type: "page",
              url: "about:blank"
            }))
          }
        : method === "Target.createTarget"
          ? { targetId: this.#createTab() }
          : method === "Target.attachToTarget"
            ? {
                sessionId: `cdp-${String((params as { targetId?: unknown })?.targetId)}`
              }
            : method === "Runtime.evaluate"
              ? { result: { value: `evaluated in ${evaluatedIn}` } }
              : method === "Page.captureScreenshot"
                ? // `fakeBytes` (not a CDP param) sizes the base64 data.
                  { data: "A".repeat(params?.fakeBytes ?? 8) }
                : {};
    if (wait) this.events.push(`start ${params?.expression}`);
    setTimeout(() => {
      if (wait) this.events.push(`end ${params?.expression}`);
      for (const fn of this.#listeners.get("message") ?? []) {
        fn({ data: JSON.stringify({ id, result }) });
      }
    }, wait);
  }
  #createTab(): string {
    const targetId = `target-${this.sessionId}-${this.tabs.length + 2}`;
    this.tabs.push(targetId);
    return targetId;
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(fn);
    this.#listeners.set(type, list);
  }
  close(): void {
    for (const fn of this.#listeners.get("close") ?? []) fn({});
  }
}

export interface FakeBrowserBinding {
  browser: BrowserBinding;
  requests: RecordedBrowserRequest[];
  /** `start`/`end` of each `wait:<ms>` evaluation, in order. */
  events: string[];
  /**
   * Simulate the platform reclaiming a session upstream: subsequent
   * `/json/list` probes for it return 410, like an expired `keep_alive`.
   */
  kill: (sessionId: string) => void;
}

/**
 * An in-memory Browser Run binding. POST acquires mint `session-N` ids,
 * `/json/list` returns one page target whose `devtoolsFrontendUrl` carries a
 * fresh token per response (so tests can prove Live View URLs are minted
 * fresh, never cached), and DELETE marks the session dead.
 */
export function createFakeBrowserBinding(): FakeBrowserBinding {
  const requests: RecordedBrowserRequest[] = [];
  const dead = new Set<string>();
  let created = 0;
  let minted = 0;
  const tabs = new Map<string, string[]>();
  const events: string[] = [];

  const browser: BrowserBinding = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input);
      const method = init?.method ?? "GET";
      const upgrade = new Headers(init?.headers).get("Upgrade") === "websocket";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ url, method, upgrade, body });

      if (upgrade) {
        const sessionId =
          url.match(/\/browser\/([^/?]+)/)?.[1] ?? "session-upgraded";
        let sessionTabs = tabs.get(sessionId);
        if (!sessionTabs) tabs.set(sessionId, (sessionTabs = []));
        const socket = new FakeBrowserSocket(sessionId, sessionTabs, events);
        const response = new Response(null, {
          headers: { "cf-browser-session-id": "session-upgraded" }
        });
        Object.defineProperty(response, "webSocket", { value: socket });
        return response;
      }
      if (method === "POST") {
        created++;
        return Response.json({ sessionId: `session-${created}` });
      }
      const sessionId = url.match(/\/browser\/([^/?]+)/)?.[1];
      if (url.endsWith("/json/list")) {
        if (!sessionId || dead.has(sessionId)) {
          return new Response(null, { status: 410 });
        }
        minted++;
        return Response.json([
          {
            id: `target-${sessionId}`,
            type: "page",
            url: "https://example.com/",
            title: "Example",
            devtoolsFrontendUrl: `https://live.browser.run/${sessionId}?token=fresh-${minted}`
          }
        ]);
      }
      if (method === "DELETE" && sessionId) dead.add(sessionId);
      return new Response(null, { status: 204 });
    }
  };

  return {
    browser,
    requests,
    events,
    kill: (sessionId) => dead.add(sessionId)
  };
}

/**
 * Minimal real host for capability-level browser tests: a Durable Object
 * whose only capability is a `Browser`, with runtime handlers
 * installed so tests can drive real Lifecycle startup, real storage, and the
 * real job queue and alarm. The binding is the in-memory fake above; its
 * requests are exposed for platform-call assertions.
 */
export class BrowserHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly #binding = createFakeBrowserBinding();
  readonly browserRequests = this.#binding.requests;
  readonly killBrowserSession = this.#binding.kill;
  readonly browser = new Browser({
    provider: browserRun(this.#binding.browser)
  });
  readonly lifecycle = Lifecycle.install(this).use(this.browser);
}
