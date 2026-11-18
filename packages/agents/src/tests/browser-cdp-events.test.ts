import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpConnection, type CdpEvent } from "../browser/cdp-connection";

/**
 * A CDP WebSocket the test drives by hand: it records what the connection
 * sends, and the test pushes replies and events in the order it wants.
 */
class ScriptedCdpSocket {
  sent: Array<{ id: number; method: string; sessionId?: string }> = [];
  #listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as (typeof this.sent)[number]);
  }

  close(): void {
    this.peerClose();
  }

  /** The browser sends a message. */
  push(message: Record<string, unknown>): void {
    this.#emit("message", { data: JSON.stringify(message) });
  }

  /** The browser sends an event. */
  event(method: string, params: unknown = {}, sessionId?: string): void {
    this.push({ method, params, ...(sessionId ? { sessionId } : {}) });
  }

  /** The browser answers the last command sent. */
  reply(result: unknown = {}): void {
    const last = this.sent.at(-1);
    if (!last) throw new Error("nothing was sent");
    this.push({ id: last.id, result });
  }

  peerClose(): void {
    this.#emit("close", {});
  }

  #emit(type: string, event: unknown): void {
    for (const fn of this.#listeners.get(type) ?? []) fn(event);
  }
}

function connect(timeoutMs = 60_000) {
  const socket = new ScriptedCdpSocket();
  // SAFETY: the connection only uses addEventListener, send and close.
  const cdp = new CdpConnection(socket as unknown as WebSocket, { timeoutMs });
  return { socket, cdp };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CdpConnection.on", () => {
  it("delivers events with their params and session", () => {
    const { socket, cdp } = connect();
    const heard: CdpEvent[] = [];
    cdp.on("Page.frameNavigated", (event) => heard.push(event));

    socket.event("Page.frameNavigated", { frame: { id: "f" } }, "s1");
    socket.event("Page.loadEventFired", {}, "s1");
    socket.push({ method: "Page.frameNavigated" });

    expect(heard).toEqual([
      {
        method: "Page.frameNavigated",
        params: { frame: { id: "f" } },
        sessionId: "s1"
      },
      { method: "Page.frameNavigated", params: {} }
    ]);
  });

  it("hears every session by default, one session, or browser level with null", () => {
    const { socket, cdp } = connect();
    const all: Array<string | undefined> = [];
    const one: Array<string | undefined> = [];
    const browserLevel: Array<string | undefined> = [];
    cdp.on("Cloudflare.handoffComplete", (e) => all.push(e.sessionId));
    cdp.on("Cloudflare.handoffComplete", (e) => one.push(e.sessionId), {
      sessionId: "s1"
    });
    cdp.on(
      "Cloudflare.handoffComplete",
      (e) => browserLevel.push(e.sessionId),
      { sessionId: null }
    );

    socket.event("Cloudflare.handoffComplete");
    socket.event("Cloudflare.handoffComplete", {}, "s1");
    socket.event("Cloudflare.handoffComplete", {}, "s2");

    expect(all).toEqual([undefined, "s1", "s2"]);
    expect(one).toEqual(["s1"]);
    expect(browserLevel).toEqual([undefined]);
  });

  it("delivers the events sent before a reply before the reply resolves", async () => {
    const { socket, cdp } = connect();
    let heard = 0;
    cdp.on("Page.frameNavigated", () => heard++);

    const navigated = cdp.send("Page.navigate", {
      url: "https://example.com/"
    });
    socket.event("Page.frameNavigated");
    socket.event("Page.frameNavigated");
    socket.reply({ frameId: "f" });
    const heardWhenReplied = await navigated.then(() => heard);

    expect(heardWhenReplied).toBe(2);
  });

  it("logs a handler that throws and still runs the others and replies", async () => {
    const { socket, cdp } = connect();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const heard: string[] = [];
    cdp.on("Page.loadEventFired", () => {
      throw new Error("boom");
    });
    cdp.on("Page.loadEventFired", () => heard.push("second"));

    const reply = cdp.send("Page.enable");
    socket.event("Page.loadEventFired");
    socket.reply();

    await expect(reply).resolves.toEqual({});
    expect(heard).toEqual(["second"]);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("Page.loadEventFired"),
      expect.objectContaining({ message: "boom" })
    );
  });

  it("stops delivering once unsubscribed, even during a delivery", () => {
    const { socket, cdp } = connect();
    const heard: string[] = [];
    let offSecond = () => {};
    const offFirst = cdp.on("Page.loadEventFired", () => {
      heard.push("first");
      offFirst();
      offSecond();
      cdp.on("Page.loadEventFired", () => heard.push("added"));
    });
    offSecond = cdp.on("Page.loadEventFired", () => heard.push("second"));

    socket.event("Page.loadEventFired");
    expect(heard).toEqual(["first"]);

    socket.event("Page.loadEventFired");
    expect(heard).toEqual(["first", "added"]);
    // Unsubscribing twice is harmless.
    offFirst();
  });

  it("keeps the debug log and reply handling as before", async () => {
    const { socket, cdp } = connect();
    cdp.on("Page.loadEventFired", () => {});
    const reply = cdp.send("Page.enable", undefined, { sessionId: "s1" });
    socket.event("Page.loadEventFired", {}, "s1");
    socket.reply({ ok: true });

    await expect(reply).resolves.toEqual({ ok: true });
    expect(
      cdp.getDebugLog().map(({ type, method, sessionId }) => ({
        type,
        method,
        sessionId
      }))
    ).toEqual([
      { type: "send", method: "Page.enable", sessionId: "s1" },
      { type: "receive", method: "Page.loadEventFired", sessionId: "s1" },
      { type: "receive", method: undefined, sessionId: undefined }
    ]);
  });

  it("stops delivering once the connection is disconnected", () => {
    const { socket, cdp } = connect();
    const heard: string[] = [];
    cdp.on("Page.loadEventFired", () => heard.push("event"));
    cdp.disconnect();
    socket.event("Page.loadEventFired");
    expect(heard).toEqual([]);
  });
});

describe("CdpConnection.waitFor", () => {
  it("hears an event that arrives before the command's reply, when registered before sending", async () => {
    const { socket, cdp } = connect();
    const loaded = cdp.waitFor("Page.loadEventFired", { sessionId: "s1" });
    const navigated = cdp.send(
      "Page.navigate",
      { url: "https://example.com/" },
      { sessionId: "s1" }
    );
    socket.event("Page.loadEventFired", { timestamp: 2 }, "s1");
    socket.reply({ frameId: "f" });

    await navigated;
    await expect(loaded).resolves.toEqual({
      method: "Page.loadEventFired",
      params: { timestamp: 2 },
      sessionId: "s1"
    });
  });

  it("waits for the session and predicate it was given", async () => {
    const { socket, cdp } = connect();
    const wanted = cdp.waitFor("Network.responseReceived", {
      sessionId: "s1",
      predicate: (event) => event.params.type === "Document"
    });
    socket.event("Network.responseReceived", { type: "Document" }, "s2");
    socket.event("Network.responseReceived", { type: "Image" }, "s1");
    socket.event("Network.responseReceived", { type: "Document" }, "s1");

    await expect(wanted).resolves.toMatchObject({
      sessionId: "s1",
      params: { type: "Document" }
    });
  });

  it("rejects when the predicate throws", async () => {
    const { socket, cdp } = connect();
    const waited = cdp.waitFor("Page.loadEventFired", {
      predicate: () => {
        throw new Error("bad predicate");
      }
    });
    socket.event("Page.loadEventFired");
    await expect(waited).rejects.toThrow("bad predicate");
  });

  it("rejects on timeout", async () => {
    vi.useFakeTimers();
    const { cdp } = connect();
    const waited = cdp.waitFor("Page.loadEventFired", { timeoutMs: 50 });
    vi.advanceTimersByTime(50);
    await expect(waited).rejects.toThrow(
      "Timed out after 50ms waiting for CDP event Page.loadEventFired"
    );
  });

  it("defaults the timeout to the connection's command timeout", async () => {
    vi.useFakeTimers();
    const { cdp } = connect(30);
    const waited = cdp.waitFor("Page.loadEventFired");
    vi.advanceTimersByTime(30);
    await expect(waited).rejects.toThrow("Timed out after 30ms");
  });

  it("rejects when the peer closes the connection", async () => {
    const { socket, cdp } = connect();
    const waited = cdp.waitFor("Page.loadEventFired");
    socket.peerClose();
    await expect(waited).rejects.toThrow(
      "CDP connection closed while waiting for Page.loadEventFired"
    );
  });

  it("rejects when the connection is disconnected, and once it has ended", async () => {
    const { cdp } = connect();
    const waited = cdp.waitFor("Page.loadEventFired");
    cdp.disconnect();
    await expect(waited).rejects.toThrow(
      "CDP session disconnected while waiting for Page.loadEventFired"
    );
    await expect(cdp.waitFor("Page.loadEventFired")).rejects.toThrow(
      "CDP connection closed while waiting for Page.loadEventFired"
    );
  });

  it("rejects with the signal's reason when it aborts", async () => {
    const { socket, cdp } = connect();
    const controller = new AbortController();
    const waited = cdp.waitFor("Page.loadEventFired", {
      signal: controller.signal
    });
    controller.abort(new Error("stopped"));
    await expect(waited).rejects.toThrow("stopped");

    // It stopped listening: a later event changes nothing.
    socket.event("Page.loadEventFired");
    const aborted = AbortSignal.abort(new Error("already"));
    await expect(
      cdp.waitFor("Page.loadEventFired", { signal: aborted })
    ).rejects.toThrow("already");
  });
});
