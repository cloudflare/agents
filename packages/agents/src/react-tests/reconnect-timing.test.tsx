/**
 * Handshake timeout and reconnect spread.
 *
 * A 101 that takes longer than the client's handshake timeout is never
 * connected: the client gives up, retries, and gives up again, while the
 * server runs the handshake work every time (measured on a deployed
 * Worker with PartySocket's 4 s default). An Agent's `onConnect` runs
 * before the 101, so one that waits on anything slow locked clients out.
 *
 * A reset drops every socket of an object at once. Clients that retry on
 * the same schedule all come back at the same moments.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { Suspense } from "react";
import { AgentClient } from "../client";
import { useAgent } from "../react";
import { getTestWorkerHost } from "./test-config";

type ReconnectOptions = {
  minReconnectionDelay?: number;
  connectionTimeout?: number;
};

/** The options PartySocket reads on every connect attempt. */
function socketOptions(socket: unknown): ReconnectOptions {
  return (socket as { _options: ReconnectOptions })._options;
}

const clients: AgentClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  cleanup();
});

function connect(name: string, options: ReconnectOptions = {}): AgentClient {
  const { host, protocol } = getTestWorkerHost();
  const client = new AgentClient({
    agent: "TestSlowConnectAgent",
    name,
    host,
    protocol,
    ...options
  });
  clients.push(client);
  return client;
}

describe("handshake timeout", () => {
  it("AgentClient connects to an Agent whose onConnect takes 6 s", async () => {
    const client = connect(`slow-${crypto.randomUUID()}`);
    await expect(
      Promise.race([
        client.ready.then(() => "ready"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 20_000))
      ])
    ).resolves.toBe("ready");
  }, 25_000);

  it("useAgent connects to an Agent whose onConnect takes 6 s", async () => {
    const { host, protocol } = getTestWorkerHost();
    const name = `slow-hook-${crypto.randomUUID()}`;
    function Probe() {
      const agent = useAgent({
        agent: "TestSlowConnectAgent",
        name,
        host,
        protocol
      });
      return (
        <div data-testid="status">
          {agent.identified ? "connected" : "connecting"}
        </div>
      );
    }
    const { container } = await render(
      <Suspense fallback={null}>
        <Probe />
      </Suspense>
    );
    // The socket's updates happen outside act().
    // @ts-expect-error - globalThis is not typed
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    await expect
      .poll(
        () => container.querySelector('[data-testid="status"]')?.textContent,
        { timeout: 20_000 }
      )
      .toBe("connected");
  }, 25_000);

  it("keeps the defaults when the caller passes undefined", () => {
    const client = connect(`slow-${crypto.randomUUID()}`, {
      connectionTimeout: undefined,
      minReconnectionDelay: undefined
    });
    expect(socketOptions(client).connectionTimeout).toBe(15_000);
    expect(socketOptions(client).minReconnectionDelay).toBeGreaterThanOrEqual(
      1000
    );
  });

  it("keeps a handshake timeout the caller sets", () => {
    const client = connect(`slow-${crypto.randomUUID()}`, {
      connectionTimeout: 1234
    });
    expect(socketOptions(client).connectionTimeout).toBe(1234);
  });
});

describe("reconnect spread", () => {
  it("gives each client its own first reconnect delay", () => {
    const delays = Array.from(
      { length: 8 },
      (_, i) =>
        socketOptions(connect(`spread-${i}-${crypto.randomUUID()}`))
          .minReconnectionDelay
    );
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(5000);
    }
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it("keeps a reconnect delay the caller sets", () => {
    const client = connect(`spread-${crypto.randomUUID()}`, {
      minReconnectionDelay: 2500
    });
    expect(socketOptions(client).minReconnectionDelay).toBe(2500);
  });
});

describe("reconnect after a drop with an async query", () => {
  // Fresh query parameters make PartySocket open a new socket, whose first
  // dial has no delay; the hook waits its reconnect delay first.
  it("waits the reconnect delay before the new socket", async () => {
    const { host, protocol } = getTestWorkerHost();
    const name = `reset-${crypto.randomUUID()}`;
    let token = 0;
    const query = async () => ({ token: String(++token) });
    let agentRef: { call(method: string): Promise<unknown> } | undefined;
    function Probe() {
      const agent = useAgent({
        agent: "TestResetAgent",
        name,
        host,
        protocol,
        query,
        minReconnectionDelay: 2000
      });
      agentRef = agent;
      return (
        <div data-testid="status">
          {agent.identified ? "connected" : "connecting"}
        </div>
      );
    }
    const { container } = await render(
      <Suspense fallback={null}>
        <Probe />
      </Suspense>
    );
    // @ts-expect-error - globalThis is not typed
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    const status = () =>
      container.querySelector('[data-testid="status"]')?.textContent;
    await expect.poll(status, { timeout: 10_000 }).toBe("connected");

    await agentRef!.call("resetForTest").catch(() => {});
    await expect.poll(status, { timeout: 5_000 }).toBe("connecting");
    const droppedAt = Date.now();
    await expect.poll(status, { timeout: 10_000 }).toBe("connected");
    expect(Date.now() - droppedAt).toBeGreaterThanOrEqual(1800);
  }, 25_000);
});
