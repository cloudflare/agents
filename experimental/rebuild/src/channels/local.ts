/**
 * LocalChannel: an in-process channel for tests and demos, and the reference
 * implementation of the Channel contract.
 *
 * Inbound: send(text) submits a user message through the Inbox with an
 * idempotency key. Outbound: an Outbox consumer over assistant messages,
 * delivering to a callback while honoring the RetryContract via dedupeKey.
 */

import type {
  Channel,
  Entry,
  Inbox,
  MessagePayload,
  NewEntry,
  RetryContract
} from "../contract.js";
import { asConsumerName, uuid } from "../ids.js";

export interface LocalDelivery {
  readonly dedupeKey: string;
  readonly attempt: number;
  readonly entries: readonly Entry[];
  readonly text: string;
}

export interface LocalChannelOptions {
  readonly name?: string;
  readonly contract?: RetryContract;
  readonly onDeliver?: (delivery: LocalDelivery) => void | Promise<void>;
}

export interface LocalChannel extends Channel {
  /** Submit a user message; resolves once durably accepted by the log. */
  send(text: string, opts?: { idempotencyKey?: string }): Promise<void>;
  /** Assistant texts delivered so far (deduped by dedupeKey). */
  readonly delivered: readonly string[];
}

export function localChannel(opts: LocalChannelOptions = {}): LocalChannel {
  const name = opts.name ?? "local";
  let inbox: Inbox | null = null;
  const delivered: string[] = [];
  const seen = new Set<string>();

  return {
    name,
    delivered,
    async send(text, sendOpts) {
      if (inbox === null) throw new Error("channel not started");
      const payload: MessagePayload = {
        kind: "message",
        v: 1,
        role: "user",
        parts: [{ type: "text", text }]
      };
      const entry = {
        origin: { module: "channel", instance: name },
        payload
      } as unknown as NewEntry;
      const result = await inbox.submit([entry], {
        idempotencyKey: sendOpts?.idempotencyKey ?? `local:${uuid()}`
      });
      if (result.outcome === "conflict") {
        throw new Error("inbox submit conflicted");
      }
    },
    start(i: Inbox) {
      inbox = i;
    },
    outbound: {
      consumer: asConsumerName(`channel:${name}`),
      filter: { kinds: ["message"] },
      contract: opts.contract ?? "at-least-once",
      async deliver(entries, deps) {
        const assistantTexts = entries
          .map((e) => e.payload as MessagePayload)
          .filter((p) => p.role === "assistant")
          .flatMap((p) => p.parts)
          .filter(
            (part): part is { type: "text"; text: string } =>
              part.type === "text"
          )
          .map((part) => part.text);
        if (assistantTexts.length === 0) return;
        // Honor the at-least-once contract with the dedupe key.
        if (seen.has(deps.dedupeKey)) return;
        seen.add(deps.dedupeKey);
        const text = assistantTexts.join("\n");
        delivered.push(text);
        await opts.onDeliver?.({
          dedupeKey: deps.dedupeKey,
          attempt: deps.attempt,
          entries,
          text
        });
      }
    }
  };
}
