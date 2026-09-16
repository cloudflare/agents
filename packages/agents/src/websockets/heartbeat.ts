/**
 * Isomorphic wire contract for the connection heartbeat.
 *
 * Imported by browser bundles (`AgentClient`, `useAgent`) and by the
 * Worker runtime, so it must not import `cloudflare:workers`.
 *
 * Cloudflare closes a WebSocket that carries no traffic in either
 * direction for a while, and it does so without a close frame: the
 * browser still reports `OPEN`, so sends succeed into nothing and the
 * reconnect path never runs. The client sends a `ping` text frame on an
 * interval; the host answers `pong` through the Durable Object's
 * auto-response pair, which never wakes the object and is free. A
 * missing `pong` is the only signal a dead socket gives, so the client
 * treats it as a drop and reconnects.
 */

/** Text frame the client sends to prove the socket is alive. */
export const HEARTBEAT_PING = "ping";
/** Text frame the host answers with. */
export const HEARTBEAT_PONG = "pong";

/** How often the client pings while the socket is open. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
/** How long the client waits for a pong before declaring the socket dead. */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * Close reason the client uses when it drops a socket that stopped
 * answering pings. The code is 1000 — a client-initiated close that the
 * reconnect classifier never treats as terminal.
 */
export const HEARTBEAT_TIMEOUT_REASON = "heartbeat timeout";

/**
 * Heartbeat policy for a client connection.
 *
 * - `{ intervalMs, timeoutMs }`: ping every `intervalMs` while the socket
 *   is open; if no `pong` arrives within `timeoutMs`, close the socket
 *   locally so the reconnect path runs. Missing fields take the defaults.
 * - `false`: send nothing. The socket is then subject to the network's
 *   idle timeout, and a silent drop is only noticed on the next send.
 */
export type HeartbeatOptions =
  | { readonly intervalMs?: number; readonly timeoutMs?: number }
  | false;

/** The slice of a reconnecting socket the heartbeat drives. */
export type HeartbeatSocket = {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  /** Close the current socket and open a new one on the same address. */
  reconnect(code?: number, reason?: string): void;
};

/**
 * Drives one socket's heartbeat: `start()` when it opens, `stop()` when
 * it closes or the owner goes away, `pong()` for every pong frame. All
 * timers are cleared by `stop()`, so a dropped controller leaks nothing.
 *
 * The controller pings on a fixed interval and arms one timeout per ping;
 * a pong clears it. A missed pong does not distinguish "the network
 * dropped the socket" from "the host is too old to answer": both end in a
 * reconnect, which is safe either way — an old host gets a fresh socket
 * every `intervalMs + timeoutMs`, a dropped one gets replaced.
 */
export class Heartbeat {
  readonly #socket: HeartbeatSocket;
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  #interval: ReturnType<typeof setInterval> | undefined;
  #timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(socket: HeartbeatSocket, options: HeartbeatOptions | undefined) {
    this.#socket = socket;
    const resolved = options === false ? undefined : options;
    this.#intervalMs =
      options === false
        ? 0
        : positiveOr(resolved?.intervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.#timeoutMs = positiveOr(
      resolved?.timeoutMs,
      DEFAULT_HEARTBEAT_TIMEOUT_MS
    );
  }

  /** Whether the policy sends pings at all. */
  get enabled(): boolean {
    return this.#intervalMs > 0;
  }

  /** Begin pinging. Idempotent; a no-op when disabled. */
  start(): void {
    if (!this.enabled || this.#interval !== undefined) return;
    this.#interval = setInterval(() => this.#ping(), this.#intervalMs);
  }

  /** Stop pinging and forget any pending pong. Idempotent. */
  stop(): void {
    if (this.#interval !== undefined) {
      clearInterval(this.#interval);
      this.#interval = undefined;
    }
    this.#clearTimeout();
  }

  /** A pong arrived: the socket is alive. */
  pong(): void {
    this.#clearTimeout();
  }

  #ping(): void {
    if (this.#socket.readyState !== this.#socket.OPEN) return;
    // One outstanding pong at a time: a second ping before the first is
    // answered would otherwise push the deadline out indefinitely.
    if (this.#timeout !== undefined) return;
    try {
      this.#socket.send(HEARTBEAT_PING);
    } catch {
      // The socket closed between the readyState check and the send;
      // the close event stops the heartbeat.
      return;
    }
    this.#timeout = setTimeout(() => {
      this.#timeout = undefined;
      this.stop();
      // The socket is dead but still reports OPEN. Replace it: the
      // reconnecting socket closes the old one, dispatches a close event
      // (so pending calls settle and `ready` resets), and opens a new one.
      this.#socket.reconnect(1000, HEARTBEAT_TIMEOUT_REASON);
    }, this.#timeoutMs);
  }

  #clearTimeout(): void {
    if (this.#timeout !== undefined) {
      clearTimeout(this.#timeout);
      this.#timeout = undefined;
    }
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
