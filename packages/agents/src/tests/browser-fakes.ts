/**
 * Fakes for the persistent-browser tests: an in-memory session store and a
 * Browser Run binding whose browsers keep their tabs between sockets.
 */
import type {
  BrowserSessionLock,
  BrowserSessionStore,
  StoredBrowserSession
} from "../browser/session-store";

export class MemorySessionStore implements BrowserSessionStore {
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
export class FakeBrowserInstance {
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

export class FakeSocket {
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

export function createFakeBrowser() {
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
