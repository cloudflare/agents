import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  Heartbeat,
  HEARTBEAT_PING,
  HEARTBEAT_TIMEOUT_REASON,
  type HeartbeatSocket
} from "../websockets/heartbeat";

/**
 * The client-side heartbeat controller `AgentClient` and `useAgent` share,
 * driven with fake timers against a socket double.
 */
function fakeSocket(): HeartbeatSocket & {
  sent: string[];
  reconnects: Array<[number | undefined, string | undefined]>;
  readyState: number;
} {
  const socket = {
    OPEN: 1,
    readyState: 1,
    sent: [] as string[],
    reconnects: [] as Array<[number | undefined, string | undefined]>,
    send(data: string) {
      socket.sent.push(data);
    },
    reconnect(code?: number, reason?: string) {
      socket.reconnects.push([code, reason]);
    }
  };
  return socket;
}

describe("Heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends ping on the interval while the socket is open", () => {
    const socket = fakeSocket();
    const heartbeat = new Heartbeat(socket, { intervalMs: 100, timeoutMs: 50 });
    heartbeat.start();

    expect(socket.sent).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(socket.sent).toEqual([HEARTBEAT_PING]);
    heartbeat.pong();
    vi.advanceTimersByTime(100);
    expect(socket.sent).toEqual([HEARTBEAT_PING, HEARTBEAT_PING]);
    heartbeat.stop();
  });

  it("uses the defaults when no policy is given", () => {
    const socket = fakeSocket();
    const heartbeat = new Heartbeat(socket, undefined);
    heartbeat.start();

    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL_MS - 1);
    expect(socket.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(socket.sent).toEqual([HEARTBEAT_PING]);
    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_TIMEOUT_MS - 1);
    expect(socket.reconnects).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(socket.reconnects).toEqual([[1000, HEARTBEAT_TIMEOUT_REASON]]);
  });

  it("a pong resets the timer so no reconnect happens", () => {
    const socket = fakeSocket();
    const heartbeat = new Heartbeat(socket, { intervalMs: 100, timeoutMs: 50 });
    heartbeat.start();

    // Every ping answered in time: no reconnect, ever.
    for (let round = 0; round < 10; round++) {
      vi.advanceTimersByTime(100);
      expect(socket.sent).toHaveLength(round + 1);
      heartbeat.pong();
    }
    // A late pong, one tick before the deadline, still counts.
    vi.advanceTimersByTime(100);
    expect(socket.sent).toHaveLength(11);
    vi.advanceTimersByTime(49);
    heartbeat.pong();
    vi.advanceTimersByTime(50);
    expect(socket.reconnects).toEqual([]);
    heartbeat.stop();
  });

  it("a missing pong reconnects the socket with a non-terminal close", () => {
    const socket = fakeSocket();
    const heartbeat = new Heartbeat(socket, { intervalMs: 100, timeoutMs: 50 });
    heartbeat.start();

    vi.advanceTimersByTime(100);
    expect(socket.sent).toEqual([HEARTBEAT_PING]);
    vi.advanceTimersByTime(49);
    expect(socket.reconnects).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(socket.reconnects).toEqual([[1000, HEARTBEAT_TIMEOUT_REASON]]);

    // Stopped on timeout: the reconnect's open event restarts it.
    vi.advanceTimersByTime(1000);
    expect(socket.sent).toEqual([HEARTBEAT_PING]);
    expect(socket.reconnects).toHaveLength(1);
  });

  it("does not ping a socket that is not open", () => {
    const socket = fakeSocket();
    socket.readyState = 0;
    const heartbeat = new Heartbeat(socket, { intervalMs: 100, timeoutMs: 50 });
    heartbeat.start();
    vi.advanceTimersByTime(500);
    expect(socket.sent).toEqual([]);
    expect(socket.reconnects).toEqual([]);
    heartbeat.stop();
  });

  it("sends nothing when disabled", () => {
    const socket = fakeSocket();
    const heartbeat = new Heartbeat(socket, false);
    expect(heartbeat.enabled).toBe(false);
    heartbeat.start();
    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL_MS * 3);
    expect(socket.sent).toEqual([]);
    expect(socket.reconnects).toEqual([]);
    heartbeat.stop();
  });

  it("stop clears both timers, and start is idempotent", () => {
    const socket = fakeSocket();
    const heartbeat = new Heartbeat(socket, { intervalMs: 100, timeoutMs: 50 });
    heartbeat.start();
    heartbeat.start();
    vi.advanceTimersByTime(100);
    expect(socket.sent).toEqual([HEARTBEAT_PING]);
    heartbeat.stop();
    heartbeat.stop();
    vi.advanceTimersByTime(1000);
    expect(socket.sent).toEqual([HEARTBEAT_PING]);
    expect(socket.reconnects).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
