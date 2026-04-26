import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { DirectoryState } from "../server";

/**
 * Open a WebSocket against the test worker for the given path.
 * Mirrors the helper used in `packages/agents/src/tests/state.test.ts`
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
 * protocol noise (identity, state, mcp_servers) before asserting on
 * the frame the test actually cares about.
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
 * Generate a directory name unique to the test invocation so parallel
 * tests don't collide on the same DO.
 */
export function uniqueDirectoryName(prefix = "alice"): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Read `AssistantDirectory.state` over the WebSocket protocol the
 * client uses, since `state` is a getter on the base Agent class and
 * isn't exposed through `getAgentByName` RPC. Connects, waits for
 * the initial `cf_agent_state` frame, closes.
 *
 * This is a substitute for the `getState()` callable that test agents
 * in `packages/agents/src/tests` add for convenience — we deliberately
 * don't modify the production class.
 */
export async function readDirectoryState(
  directoryName: string
): Promise<DirectoryState> {
  const { ws } = await connectWS(
    `/agents/assistant-directory/${directoryName}`
  );
  try {
    const frame = await waitForMatching<{ type?: string; state?: unknown }>(
      ws,
      (msg) =>
        typeof msg === "object" &&
        msg !== null &&
        (msg as { type?: string }).type === "cf_agent_state",
      3000
    );
    return frame.state as DirectoryState;
  } finally {
    ws.close();
  }
}
