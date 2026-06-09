import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import type { OnErrorCapture } from "./agents/on-error.ts";

// Regression tests for #388: when .sql (or anything else) throws while the
// agent is handling a websocket message, the actual error must be delivered
// to onError(connection, error) — the error in the error slot, the connection
// in the connection slot. Before the fix, _tryCatch called this.onError(e)
// with a single argument, so a user override written with the documented
// two-parameter signature received the error AS the connection and an
// undefined error — "my agent is silently failing and i have no clue why".

async function connectWS(path: string) {
  const res = await exports.default.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws };
}

describe("onError receives the actual error thrown by .sql (#388)", () => {
  it("delivers (connection, error) to a two-parameter onError override", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectWS(`/agents/test-on-error-agent/${room}`);
    ws.send("throw-sql");

    const agent = await getAgentByName(env.TestOnErrorAgent, room);
    let captures: OnErrorCapture[] = [];
    const start = Date.now();
    while (captures.length === 0 && Date.now() - start < 2000) {
      captures = await agent.getCaptures();
      if (captures.length === 0) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    ws.close();

    expect(captures.length).toBe(1);
    const capture = captures[0];
    // The error slot must carry the actual SqlError…
    expect(capture.errorDefined).toBe(true);
    expect(capture.errorName).toBe("SqlError");
    expect(capture.errorMessage).toContain("no such table");
    // …and the connection slot must carry the Connection, not the error.
    expect(capture.firstArgIsConnection).toBe(true);
    expect(capture.firstArgErrorMessage).toBeNull();
  });
});

describe("base onError overload discrimination", () => {
  it("rethrows the original error for a connection error", async () => {
    const agent = await getAgentByName(env.TestStateAgent, "on-error-ws");
    const result = await agent.probeOnError("ws-error");
    expect(result.thrown).toBe("Error");
    expect(result.message).toBe("ws boom");
  });

  it("rethrows the original error for a server error", async () => {
    const agent = await getAgentByName(env.TestStateAgent, "on-error-server");
    const result = await agent.probeOnError("server-error");
    expect(result.thrown).toBe("Error");
    expect(result.message).toBe("server boom");
  });

  it("passes an undefined connection error through untouched", async () => {
    // No injection: a two-argument call with no error detail must not throw
    // the Connection object (the old truthiness misroute) and must not
    // synthesize a stand-in Error — it rethrows exactly what was passed.
    const agent = await getAgentByName(env.TestStateAgent, "on-error-ws-undef");
    const result = await agent.probeOnError("ws-undefined-error");
    expect(result.thrown).toBe("undefined");
  });
});
