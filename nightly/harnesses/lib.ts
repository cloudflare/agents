// What the Pi and OpenCode suites share: control calls to the harness
// Worker and the waits on its state.

import { inject } from "vitest";

export type Kind = "pi" | "opencode";
export type Result = {
  status: "done" | "unanswered";
  text?: string;
  reason?: string;
};
export type State = { pending: number; alarm: number | null; entries: number };

export async function call<T>(
  kind: Kind,
  room: string,
  method: string,
  ...args: unknown[]
): Promise<T> {
  const res = await fetch(
    `${inject("probeUrl")}/ctl/${kind}/${room}/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-probe-key": inject("probeKey")
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(240_000)
    }
  );
  const body = (await res.json()) as { ok: boolean; value?: T; error?: string };
  if (!body.ok) throw new Error(`${method}: ${body.error}`);
  return body.value as T;
}

/** Poll `read` until `pred` holds; a read that throws (a reset) is retried. */
export async function until<T>(
  read: () => Promise<T>,
  pred: (v: T) => boolean,
  label: string,
  timeoutMs = 120_000
): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  for (;;) {
    last = await read().catch(() => undefined);
    if (last !== undefined && pred(last)) return last;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** An operation's end; a reset breaks a waiting call, so ask again. */
export function ended(
  kind: Kind,
  room: string,
  operationId: string
): Promise<Result> {
  return until(
    () => call<Result>(kind, room, "probeWait", operationId),
    () => true,
    `${operationId} to end`,
    240_000
  );
}

/**
 * Nothing pending, then no alarm: the harness let the object go idle. The
 * pending count is read once: reading it uses the harness, and OpenCode is
 * only closed (and its alarm cleared) 30 s after its last use, so the wait
 * for the alarm reads storage alone.
 */
export async function idle(kind: Kind, room: string): Promise<State> {
  const state = await call<State>(kind, room, "probeState");
  if (state.pending !== 0)
    throw new Error(`${room}: ${state.pending} operations still pending`);
  await until(
    () => call<number | null>(kind, room, "probeAlarm"),
    (a) => a === null,
    `${room} to clear its alarm`,
    180_000
  );
  return state;
}

export function submit(kind: Kind, room: string, text: string) {
  return call<{ operationId: string }>(kind, room, "probeSubmit", text);
}

/** What the room's tools and objects did, read from the witness: it never wakes the probe. */
export async function witness(room: string, key: string): Promise<number> {
  const res = await fetch(`${inject("probeUrl")}/witness/${room}/${key}`, {
    headers: { "x-probe-key": inject("probeKey") },
    signal: AbortSignal.timeout(30_000)
  });
  const body = (await res.json()) as { ok: boolean; value?: number };
  return body.value ?? 0;
}

/** Until the witness counts `n` of `key`, without touching the probe. */
export function seen(
  room: string,
  key: string,
  n: number,
  timeoutMs = 180_000
) {
  return until(
    () => witness(room, key),
    (v) => v >= n,
    `${key} x${n}`,
    timeoutMs
  );
}

/** Reset the object; the call itself fails with the reset. */
export async function reset(kind: Kind, room: string) {
  await call(kind, room, "probeReset").catch(() => undefined);
}
