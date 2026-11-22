/**
 * Server-written turn context on user messages: the channel a turn ran on
 * and the caller's turn metadata. Both are stamped on the durable user
 * message so a recovered or continued turn re-resolves them from history,
 * and both are reserved keys that a client can never set.
 */

import type { UIMessage } from "ai";

/**
 * Message-metadata keys that are server-written turn context (stamped by
 * {@link stampTurnContext}) and trusted by hooks and recovery. They are
 * stripped from client-supplied messages at intake so a client can never
 * forge them.
 */
export const RESERVED_MESSAGE_METADATA_KEYS = [
  "channel",
  "turnMetadata"
] as const;

/** The reserved keys `message` carries, or `undefined` when it has none. */
export function reservedMetadataOf(
  message: UIMessage
): Record<string, unknown> | undefined {
  const metadata = message.metadata;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return undefined;
  }
  const reserved: Record<string, unknown> = {};
  for (const key of RESERVED_MESSAGE_METADATA_KEYS) {
    if (key in metadata) {
      reserved[key] = (metadata as Record<string, unknown>)[key];
    }
  }
  return Object.keys(reserved).length > 0 ? reserved : undefined;
}

/**
 * The stored form of a client-sourced message's metadata: Sessions drops the
 * reserved keys on every client write, so a compare against a stored row has
 * to drop them too. Mirrors `SessionCore.stripReservedMetadata` for the keys
 * Think registers.
 */
export function stripReservedMetadata(message: UIMessage): UIMessage {
  const metadata = message.metadata;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return message;
  }
  const remaining: Record<string, unknown> = { ...metadata };
  let changed = false;
  for (const key of RESERVED_MESSAGE_METADATA_KEYS) {
    if (key in remaining) {
      delete remaining[key];
      changed = true;
    }
  }
  if (!changed) return message;
  if (Object.keys(remaining).length > 0) {
    return { ...message, metadata: remaining };
  }
  const { metadata: _dropped, ...withoutMetadata } = message;
  return withoutMetadata as UIMessage;
}

/**
 * Stamp the channel id, and the caller's turn metadata when supplied, onto
 * the user messages.
 */
export function stampTurnContext(
  messages: UIMessage[],
  channel: string | undefined,
  turnMetadata?: Record<string, unknown>
): UIMessage[] {
  if (!channel && !turnMetadata) {
    return messages;
  }
  return messages.map((message) =>
    message.role === "user"
      ? {
          ...message,
          metadata: {
            ...(message.metadata as Record<string, unknown> | undefined),
            ...(channel ? { channel } : {}),
            ...(turnMetadata ? { turnMetadata } : {})
          }
        }
      : message
  );
}

/** Metadata of the latest user message in the given list, if any. */
function latestUserMessageMetadata(
  messages: UIMessage[]
): Record<string, unknown> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") {
      return message.metadata as Record<string, unknown> | undefined;
    }
  }
  return undefined;
}

/** The channel stamped on the latest user message in the given list, if any. */
export function channelFromMessages(messages: UIMessage[]): string | undefined {
  const channel = latestUserMessageMetadata(messages)?.channel;
  return typeof channel === "string" ? channel : undefined;
}

/** The turn metadata stamped on the latest user message, if any. */
export function turnMetadataFromMessages(
  messages: UIMessage[]
): Record<string, unknown> | undefined {
  const turnMetadata = latestUserMessageMetadata(messages)?.turnMetadata;
  return turnMetadata &&
    typeof turnMetadata === "object" &&
    !Array.isArray(turnMetadata)
    ? (turnMetadata as Record<string, unknown>)
    : undefined;
}

/**
 * How to store a message the client posted, or `null` to skip it because
 * the server already holds the same stored form. The client posts its whole
 * transcript on every request, so skipping unchanged rows is what keeps a
 * turn's storage traffic independent of transcript length.
 *
 * Reserved metadata is server-owned: the client's copy is ignored, a stored
 * row keeps its own, and a new user message gets `channel` when the caller
 * supplies one. A message with no reserved metadata to keep is written as
 * the client sent it.
 */
export function incomingMessageWrite(
  sanitized: UIMessage,
  original: UIMessage,
  prior: UIMessage | undefined,
  channel: string | undefined
): { message: UIMessage; source: "client" | "server" } | null {
  const incoming = stripReservedMetadata(sanitized);
  if (
    prior &&
    JSON.stringify(stripReservedMetadata(prior)) === JSON.stringify(incoming)
  ) {
    return null;
  }
  const reserved = prior
    ? reservedMetadataOf(prior)
    : incoming.role === "user" && channel
      ? { channel }
      : undefined;
  if (!reserved) {
    return { message: original, source: "client" };
  }
  return {
    message: {
      ...incoming,
      metadata: {
        ...(incoming.metadata as Record<string, unknown> | undefined),
        ...reserved
      }
    },
    source: "server"
  };
}
