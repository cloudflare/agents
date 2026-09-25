import { DurableObject } from "cloudflare:workers";
import type { BrowserBinding } from "../../browser/browser-run";
import { BrowserSessions } from "../../browser/capability";
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
 * commands the browser tool issues against the session's one page target.
 */
class FakeBrowserSocket {
  #listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly sessionId: string) {}
  accept(): void {}
  send(data: string): void {
    const { id, method } = JSON.parse(data) as { id: number; method: string };
    const targetId = `target-${this.sessionId}`;
    const result =
      method === "Target.getTargets"
        ? {
            targetInfos: [
              { targetId, type: "page", url: "https://example.com/" }
            ]
          }
        : method === "Target.attachToTarget"
          ? { sessionId: `cdp-${targetId}` }
          : method === "Runtime.evaluate"
            ? { result: { value: `evaluated in ${targetId}` } }
            : {};
    queueMicrotask(() => {
      for (const fn of this.#listeners.get("message") ?? []) {
        fn({ data: JSON.stringify({ id, result }) });
      }
    });
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

  const browser: BrowserBinding = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = String(input);
      const method = init?.method ?? "GET";
      const upgrade = new Headers(init?.headers).get("Upgrade") === "websocket";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ url, method, upgrade, body });

      if (upgrade) {
        const socket = new FakeBrowserSocket(
          url.match(/\/browser\/([^/?]+)/)?.[1] ?? "session-upgraded"
        );
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

  return { browser, requests, kill: (sessionId) => dead.add(sessionId) };
}

/**
 * Minimal real host for capability-level browser-session tests: a Durable
 * Object whose only capability is `BrowserSessions`, with runtime handlers
 * installed so tests can drive real Lifecycle startup, real storage, and the
 * real job queue and alarm. The binding is the in-memory fake above; its
 * requests are exposed for platform-call assertions.
 */
export class BrowserHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly #binding = createFakeBrowserBinding();
  readonly browserRequests = this.#binding.requests;
  readonly killBrowserSession = this.#binding.kill;
  readonly browser = new BrowserSessions({ browser: this.#binding.browser });
  readonly lifecycle = Lifecycle.install(this).use(this.browser);
}
