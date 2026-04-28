import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { HelperEventMessage } from "../protocol";

/**
 * Open a WebSocket against the test worker for the given path.
 * Mirrors the helper used in `examples/assistant/src/tests/helpers.ts`
 * — `Upgrade: websocket` against `exports.default.fetch` returns a
 * 101 with a paired `webSocket`, which we accept and hand back.
 */
export async function connectWS(path: string): Promise<{ ws: WebSocket }> {
  const res = await exports.default.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

/**
 * Resolve when the websocket emits the next message. Times out so a
 * test asserting "should not broadcast" can fail fast rather than
 * hanging.
 */
export function nextMessage(ws: WebSocket, timeoutMs = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for WebSocket message")),
      timeoutMs
    );
    ws.addEventListener(
      "message",
      (e: MessageEvent) => {
        clearTimeout(timer);
        resolve(typeof e.data === "string" ? e.data : "");
      },
      { once: true }
    );
  });
}

/**
 * Drain WebSocket messages until `predicate` returns true, then
 * resolve with the matching frame. Used to skip Agent's initial
 * protocol noise (identity, state, MSG_CHAT_MESSAGES, etc.) before
 * asserting on the helper-event frames the tests actually care about.
 */
export async function waitForMatching<T = unknown>(
  ws: WebSocket,
  predicate: (msg: T) => boolean,
  timeoutMs = 2000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(50, deadline - Date.now());
    const raw = await nextMessage(ws, remaining);
    let parsed: T;
    try {
      parsed = JSON.parse(raw) as T;
    } catch {
      continue;
    }
    if (predicate(parsed)) {
      return parsed;
    }
  }
  throw new Error("Timeout waiting for matching WebSocket message");
}

/**
 * Drain WebSocket messages for a fixed window, returning every
 * `helper-event` frame seen. Used by replay tests that want to assert
 * "exactly these N events arrived, in this order" — they collect a
 * window's worth of frames and slice on `helper-event`.
 *
 * The window is wall-clock based: we keep reading until either
 * `timeoutMs` elapses or we observe `terminate(frame)` returning true
 * for a freshly-decoded frame. The early-exit option lets tests stop
 * as soon as the run's last expected event arrives, which keeps the
 * suite fast.
 */
export async function collectHelperEvents(
  ws: WebSocket,
  options: {
    timeoutMs?: number;
    /** Stop early when this returns true for the most recent helper-event. */
    terminate?: (frame: HelperEventMessage) => boolean;
  } = {}
): Promise<HelperEventMessage[]> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  const collected: HelperEventMessage[] = [];

  while (Date.now() < deadline) {
    const remaining = Math.max(50, deadline - Date.now());
    let raw: string;
    try {
      raw = await nextMessage(ws, remaining);
    } catch {
      // Timed out waiting for the next frame — return what we have.
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "helper-event"
    ) {
      const frame = parsed as HelperEventMessage;
      collected.push(frame);
      if (options.terminate?.(frame)) {
        break;
      }
    }
  }

  return collected;
}

/**
 * Generate an assistant name unique to the test invocation so parallel
 * tests don't collide on the same DO.
 */
export function uniqueAssistantName(prefix = "user"): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Persistent accumulator of `helper-event` frames on a WebSocket.
 *
 * Unlike {@link collectHelperEvents} (which lazily attaches a fresh
 * `once` listener for each new message), this attaches a single
 * permanent listener at call time and accumulates frames as they
 * arrive. Use this when the test drives work that broadcasts events
 * BEFORE the test has a chance to start awaiting — e.g. concurrent
 * `_runHelperTurn` calls that complete inside a `Promise.all`
 * before any per-message await fires.
 *
 *     const { frames, stop } = startCollectingHelperEvents(ws);
 *     await Promise.all([driveHelperA(), driveHelperB()]);
 *     await sleep(50); // give the WS handler one tick to flush
 *     stop();
 *     expect(frames).toMatchSnapshot();
 */
export function startCollectingHelperEvents(ws: WebSocket): {
  frames: HelperEventMessage[];
  stop: () => void;
} {
  const frames: HelperEventMessage[] = [];
  const handler = (e: MessageEvent) => {
    if (typeof e.data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.data);
    } catch {
      return;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "helper-event"
    ) {
      frames.push(parsed as HelperEventMessage);
    }
  };
  ws.addEventListener("message", handler);
  return {
    frames,
    stop: () => ws.removeEventListener("message", handler)
  };
}
