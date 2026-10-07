/**
 * The object's side of one session socket: dial the daemon through the
 * container's TCP port, read its `hello`, then hand every later frame to
 * the harness. Failures to reach the daemon are values, so the harness can
 * decide between retrying and giving up.
 */

import {
  CONTAINER_HEALTH_PATH,
  CONTAINER_PROTOCOL_VERSION,
  CONTAINER_SESSION_PATH,
  CONTAINER_TOKEN_HEADER,
  parseDaemonMessage,
  type DaemonFrame,
  type DaemonMessage,
  type HostMessage
} from "./protocol";

/** The daemon's greeting. */
export type Hello = Extract<DaemonMessage, { type: "hello" }>;

/** Why a link could not be opened. */
export type LinkError =
  | { readonly _tag: "unreachable"; readonly message: string }
  | { readonly _tag: "protocol"; readonly message: string };

/** A link result. */
export type LinkResult<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: LinkError };

/** What the link reports after `hello`. */
export type LinkHandlers = {
  frame(seq: number, frame: DaemonFrame): void;
  /** The daemon has sent every frame it kept after the replay cursor. */
  caughtUp(): void;
  /** The socket closed, from either side. Called once. */
  closed(): void;
};

const HELLO_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 2_000;

function unreachable(message: string): LinkResult<never> {
  return { _tag: "err", error: { _tag: "unreachable", message } };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wait until the daemon answers its health check.
 *
 * @param port - The container's TCP port.
 * @param timeoutMs - How long to keep trying.
 * @param running - Whether the container still runs; waiting stops early
 *   once it does not.
 * @returns `ok`, or `unreachable` after the timeout or once it stops.
 */
export async function waitHealthy(
  port: Fetcher,
  timeoutMs: number,
  running: () => boolean
): Promise<LinkResult<void>> {
  const deadline = Date.now() + timeoutMs;
  let delay = 250;
  let last = "no answer";
  for (;;) {
    try {
      const response = await port.fetch(
        `http://container${CONTAINER_HEALTH_PATH}`,
        { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) }
      );
      await response.body?.cancel();
      if (response.ok) return { _tag: "ok", value: undefined };
      last = `health check answered ${response.status}`;
    } catch (error) {
      last = errorText(error);
    }
    if (!running()) return unreachable("the container stopped");
    if (Date.now() + delay > deadline) return unreachable(last);
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 2_000);
  }
}

/** One open session socket. */
export class DaemonLink {
  readonly #socket: WebSocket;
  #open = true;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
  }

  /**
   * Dial the daemon for one session and wait for its `hello`.
   *
   * @param port - The container's TCP port.
   * @param session - The session id.
   * @param token - The shared secret the container was started with.
   * @param handlers - Called for frames after `hello`, and on close.
   * @returns The link and the greeting, or why it failed.
   */
  static async open(
    port: Fetcher,
    session: string,
    token: string,
    handlers: LinkHandlers
  ): Promise<LinkResult<{ readonly link: DaemonLink; readonly hello: Hello }>> {
    let response: Response;
    try {
      response = await port.fetch(
        `http://container${CONTAINER_SESSION_PATH}${encodeURIComponent(session)}`,
        {
          headers: { Upgrade: "websocket", [CONTAINER_TOKEN_HEADER]: token },
          signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS)
        }
      );
    } catch (error) {
      return unreachable(errorText(error));
    }
    const socket = response.webSocket;
    if (!socket) {
      await response.body?.cancel();
      return unreachable(`upgrade refused with ${response.status}`);
    }
    socket.accept();
    const link = new DaemonLink(socket);
    return new Promise((resolve) => {
      let greeted = false;
      const timer = setTimeout(() => {
        if (greeted) return;
        link.close();
        resolve(unreachable("no hello from the daemon"));
      }, HELLO_TIMEOUT_MS);
      socket.addEventListener("message", (event) => {
        const text =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data);
        const message = parseDaemonMessage(text);
        if (!message) return;
        if (!greeted) {
          if (message.type !== "hello") return;
          greeted = true;
          clearTimeout(timer);
          if (message.protocol !== CONTAINER_PROTOCOL_VERSION) {
            link.close();
            resolve({
              _tag: "err",
              error: {
                _tag: "protocol",
                message: `daemon speaks protocol ${message.protocol}, the harness ${CONTAINER_PROTOCOL_VERSION}`
              }
            });
            return;
          }
          resolve({ _tag: "ok", value: { link, hello: message } });
          return;
        }
        if (message.type === "frame")
          handlers.frame(message.seq, message.frame);
        else if (message.type === "caught-up") handlers.caughtUp();
      });
      const onClose = () => {
        if (!link.#open) return;
        link.#open = false;
        clearTimeout(timer);
        if (!greeted) resolve(unreachable("socket closed before hello"));
        else handlers.closed();
      };
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onClose);
    });
  }

  /** Whether the socket is still open. */
  get open(): boolean {
    return this.#open;
  }

  /**
   * Send one message. Returns false when the socket has closed.
   *
   * @param message - The message.
   * @returns Whether it was handed to the socket.
   */
  send(message: HostMessage): boolean {
    if (!this.#open) return false;
    try {
      this.#socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Close the socket. Does not call `closed`. */
  close(): void {
    if (!this.#open) return;
    this.#open = false;
    try {
      this.#socket.close(1000, "closed by the harness");
    } catch {
      // Already closing.
    }
  }
}
