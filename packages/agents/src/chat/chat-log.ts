/**
 * The chat event log: every frame a chat host broadcasts to its tabs is an
 * event in one log (`cf_chat`) on the host's WebSockets capability, so a
 * tab that reconnects gets what it missed by cursor, terminal frames
 * included, and a new tab rebuilds from {@link ChatLogSnapshot}.
 *
 * @internal Sibling-package support, not a public API. See
 * `design/event-log.md`.
 */

import type { EventLogOptions } from "../websockets/event-log";
import type { ChatLogEvent } from "./chat-frames";
import {
  CHAT_RECOVERING_FLAG_TTL_MS,
  CHAT_RECOVERING_KEY
} from "./recovery-incident";

/**
 * The stream a turn is producing now, as a tab rebuilds it.
 *
 * @internal
 */
export type ChatLogActiveStream = {
  readonly requestId: string;
  readonly continuation: boolean;
  readonly messageId?: string;
  readonly seqBase: number;
  /** Every chunk body stored so far, in order. */
  readonly chunks: readonly string[];
};

/**
 * What a tab rebuilds from on resync: the stored transcript as tabs see
 * it, the in-flight stream so far, and whether a turn is recovering.
 *
 * @internal
 */
export type ChatLogSnapshot<TMessage = unknown> = {
  readonly messages: readonly TMessage[];
  readonly queuedMessageIds?: readonly string[];
  readonly active?: ChatLogActiveStream;
  /** The request being recovered, or true when it has no id. */
  readonly recovering?: string | true;
};

/** What the chat log reads to build a snapshot. @internal */
export interface ChatLogSource<TMessage extends { id: string }> {
  /** The stored transcript. */
  messages(): readonly TMessage[];
  /** The message list a tab is sent (`ChatTurns.clientView`). */
  clientView(messages: ReadonlyArray<TMessage>): {
    messages: TMessage[];
    queuedMessageIds?: string[];
  };
  /** The active stream (`ResumableStream.activeSnapshot`). */
  activeStream(): ChatLogActiveStream | null;
  /** The host's synchronous KV, where the recovering flag lives. */
  kv: Pick<SyncKvStorage, "get">;
}

/** Events the chat log keeps for replay. */
const CHAT_LOG_RETENTION = { maxEvents: 5000, maxBytes: 8 * 1024 * 1024 };
/** A chunk frame can carry up to `CHUNK_MAX_BYTES` (1.8 MB) of body. */
const CHAT_LOG_MAX_EVENT_BYTES = 1_900_000;

/**
 * Options for the host's `cf_chat` event log.
 *
 * @internal
 */
export function chatLogOptions<TMessage extends { id: string }>(
  source: ChatLogSource<TMessage>
): EventLogOptions<ChatLogSnapshot<TMessage>> {
  return {
    retention: CHAT_LOG_RETENTION,
    maxEventBytes: CHAT_LOG_MAX_EVENT_BYTES,
    snapshot: () => {
      const view = source.clientView(source.messages());
      const active = source.activeStream();
      const recovering = readRecovering(source.kv, Date.now());
      return {
        messages: view.messages,
        ...(view.queuedMessageIds && {
          queuedMessageIds: view.queuedMessageIds
        }),
        ...(active && { active }),
        ...(recovering !== undefined && { recovering })
      };
    }
  };
}

/** The recovering flag, synchronously, with the same TTL as on connect. */
function readRecovering(
  kv: Pick<SyncKvStorage, "get">,
  now: number
): string | true | undefined {
  const record = kv.get(CHAT_RECOVERING_KEY) as
    | { requestId?: string; at?: number }
    | undefined;
  if (!record || now - (record.at ?? 0) >= CHAT_RECOVERING_FLAG_TTL_MS) {
    return undefined;
  }
  return record.requestId ?? true;
}

export type { ChatLogEvent };
