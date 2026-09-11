import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { routeAgentRequest } from "../..";

export const PARENT = "dynamic-parent-object";
export const CHILD = "dynamic-child-object";
export const GRANDCHILD = "dynamic-grandchild-object";

export function parentUrl(name: string, tail = ""): string {
  return `https://example.com/agents/${PARENT}/${name}${tail}`;
}

export function childUrl(parent: string, child: string, tail = ""): string {
  return parentUrl(parent, `/sub/${CHILD}/${child}${tail}`);
}

export function grandchildUrl(
  parent: string,
  child: string,
  grandchild: string,
  tail = ""
): string {
  return childUrl(parent, child, `/sub/${GRANDCHILD}/${grandchild}${tail}`);
}

export function parentStub(name: string) {
  return env.DynamicParentObject.getByName(name);
}

export async function fetchThrough(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const response = await routeAgentRequest(new Request(url, init), env);
  expect(response).not.toBeNull();
  return response as Response;
}

export type OpenSocket = {
  readonly socket: WebSocket;
  /** The next frame, in arrival order. */
  next(): Promise<string>;
  /** Resolves when the peer closes the socket. */
  readonly closed: Promise<{ code: number; reason: string }>;
  close(code?: number, reason?: string): void;
};

/** Open a WebSocket through the router, or return the rejection response. */
export async function tryConnect(
  url: string,
  init?: RequestInit
): Promise<{ response: Response; open?: OpenSocket }> {
  const response = await fetchThrough(url, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string>),
      Upgrade: "websocket"
    }
  });
  if (response.status !== 101 || !response.webSocket) return { response };
  const socket = response.webSocket;
  socket.accept();
  const queue: string[] = [];
  const waiters: Array<(message: string) => void> = [];
  socket.addEventListener("message", (event) => {
    const message = String(event.data);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason })
    );
  });
  return {
    response,
    open: {
      socket,
      next: () =>
        queue.length > 0
          ? Promise.resolve(queue.shift() as string)
          : new Promise<string>((resolve) => waiters.push(resolve)),
      closed,
      close: (code, reason) => socket.close(code, reason)
    }
  };
}

export async function connect(
  url: string,
  init?: RequestInit
): Promise<OpenSocket> {
  const { response, open } = await tryConnect(url, init);
  expect(response.status).toBe(101);
  return open as OpenSocket;
}

export async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!predicate(last)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting; last value: ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    last = await read();
  }
  return last;
}
