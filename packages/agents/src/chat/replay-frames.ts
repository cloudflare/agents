/**
 * Wire framing for resumable-stream replay: the `USE_CHAT_RESPONSE` frames a
 * reconnecting client receives when stored chunks are replayed to it. Pure
 * senders over one connection — the store and lifecycle decisions stay in
 * `ResumableStream`.
 */

import type { Connection } from "agents";
import { CHAT_MESSAGE_TYPES } from "./protocol";
import { sendIfOpen } from "./connection";

/**
 * Send stored chunk bodies to a connection as replay frames.
 *
 * @returns False when the connection closed mid-replay — the caller leaves
 * its stream state untouched so the next reconnect can retry.
 */
export function sendReplayBodies(
  connection: Connection,
  requestId: string,
  bodies: Iterable<string>,
  continuation: boolean
): boolean {
  for (const body of bodies) {
    const sent = sendIfOpen(
      connection,
      JSON.stringify({
        body,
        done: false,
        id: requestId,
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        replay: true,
        ...(continuation && { continuation: true })
      })
    );
    if (!sent) return false;
  }
  return true;
}

/**
 * Send one replay control frame: `done: true` ends the replayed stream;
 * `replayComplete` tells a live client to flush accumulated parts and keep
 * listening. Replay frames must mirror what a live client observed,
 * including the continuation flag (#1733).
 */
export function sendReplayControl(
  connection: Connection,
  requestId: string,
  options: { done: boolean; replayComplete?: boolean; continuation: boolean }
): boolean {
  return sendIfOpen(
    connection,
    JSON.stringify({
      body: "",
      done: options.done,
      id: requestId,
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      replay: true,
      ...(options.replayComplete && { replayComplete: true }),
      ...(options.continuation && { continuation: true })
    })
  );
}
