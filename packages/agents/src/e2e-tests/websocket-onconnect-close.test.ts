/**
 * E2E test: a socket closed from `onConnect` reaches a real network client.
 *
 * `onConnect` runs before the 101 response exists. Under `wrangler dev`, a
 * hibernating socket closed at that point sends its Close frame but the
 * runtime never ends the connection, so a real client never sees `close`.
 * The in-process vitest pool cannot show this: its sockets never touch the
 * network. The hosts here send one frame, then close with 4404.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import {
  killProcess,
  killProcessOnPort,
  startWrangler,
  waitForReady,
  type Harness
} from "./recovery-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18830;
const HARNESS: Harness = {
  configPath: path.join(__dirname, "wrangler.jsonc"),
  port: PORT,
  persistDir: path.join(__dirname, ".wrangler-onconnect-close-state")
};

type Received =
  | { readonly kind: "message"; readonly data: string }
  | { readonly kind: "close"; readonly code: number; readonly reason: string };

/** Connect, then record every text frame and the close, in order. */
function receiveUntilClose(agentPath: string): Promise<Received[]> {
  const ws = new WebSocket(`ws://localhost:${PORT}${agentPath}`);
  const received: Received[] = [];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(
        new Error(`socket never closed; received ${JSON.stringify(received)}`)
      );
    }, 5000);
    ws.addEventListener("message", (event) => {
      received.push({ kind: "message", data: String(event.data) });
    });
    ws.addEventListener("close", (event) => {
      clearTimeout(timeout);
      received.push({ kind: "close", code: event.code, reason: event.reason });
      resolve(received);
    });
  });
}

describe("closing a WebSocket from onConnect over the network", () => {
  let wrangler: ChildProcess | null = null;

  beforeAll(async () => {
    killProcessOnPort(PORT);
    fs.rmSync(HARNESS.persistDir, { recursive: true, force: true });
    wrangler = startWrangler(HARNESS);
    await waitForReady(HARNESS);
  });

  afterAll(async () => {
    if (wrangler) await killProcess(wrangler);
    killProcessOnPort(PORT);
    fs.rmSync(HARNESS.persistDir, { recursive: true, force: true });
  });

  it.each([
    ["a WebSockets capability handler", "on-connect-close-object"],
    ["Agent.onConnect", "on-connect-close-agent"]
  ])(
    "delivers the close from %s after the frames sent before it",
    async (_label, agent) => {
      const received = await receiveUntilClose(
        `/agents/${agent}/${crypto.randomUUID()}`
      );

      expect(received.at(-1)).toEqual({
        kind: "close",
        code: 4404,
        reason: "Unknown session"
      });
      expect(received.at(-2)).toEqual({
        kind: "message",
        data: "unknown session"
      });
    }
  );
});
