import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "./worker";

function requireWebSocket(response: Response): WebSocket {
  const webSocket = response.webSocket;
  if (!webSocket) {
    throw new Error("Expected a WebSocket upgrade response");
  }
  return webSocket;
}

// Layer B: the fast, date-parametrized CI gate for the binaryType contract.
//
// The `BinaryTypeProbe` DO reports its server-side `connection.binaryType` in
// onConnect. On compatibility dates >= 2026-03-17 the
// `websocket_standard_binary_type` flag flips the default to "blob"; the pin in
// `InMemoryConnectionManager.accept` must keep it "arraybuffer". This file is
// included in both the normal suite (at the wrangler.jsonc date) AND the
// compat-matrix run (`vitest.compat.config.ts`, which overrides the date via
// the COMPAT_DATE env var), so the contract is locked across the matrix.

const COMPAT_DATE = process.env.COMPAT_DATE ?? "wrangler-default (2026-06-11)";

describe(`binaryType contract @ ${COMPAT_DATE}`, () => {
  it("delivers a non-hibernating connection's binaryType as 'arraybuffer'", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://example.com/parties/binary-type-probe/probe-room", {
        headers: { Upgrade: "websocket" }
      }),
      env,
      ctx
    );

    expect(res.webSocket).toBeTruthy();
    const ws = requireWebSocket(res);
    ws.accept();

    const reported = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for binaryType report")),
        2000
      );
      ws.addEventListener(
        "message",
        (event) => {
          clearTimeout(timer);
          resolve(String(event.data));
        },
        { once: true }
      );
    });

    expect(reported).toBe("arraybuffer");
    ws.close(1000, "done");
  });
});
