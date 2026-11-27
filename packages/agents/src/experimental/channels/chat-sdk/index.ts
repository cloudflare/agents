import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Adapter,
  ChatInstance,
  Logger,
  Message,
  StateAdapter
} from "chat";
import type {
  Channel,
  ChannelParticipant,
  ChannelRoute,
  DeliveryResult
} from "../channel";
import type {
  ChannelIngressEnvelope,
  ChannelIngressEventInput
} from "../ingress";
import { matchesPath } from "../ingress";
import type { ResponseChunk } from "../protocol";
import {
  INTERRUPTED_NOTICE,
  posting,
  reportingPosting,
  SupersededResponse
} from "../deliveries";
import { createTextCollector } from "../stream";
import type { ChannelMessageSurface } from "../surface";

/** Where a Chat SDK thread is: the adapter's encoded thread id. */
export type ChatSdkAddress = { threadId: string };

/** @internal */
export type ChatSdkChannelOptions = {
  /** The Chat SDK adapter, as configured for the platform. */
  adapter: Adapter;
  /** Names the adapter in event ids and labels: `telegram`, `slack`… */
  name: string;
  /** The webhook path the platform posts to. */
  path: string;
  /** Who a sender is. Required to take webhooks. */
  participant?: ChannelParticipant<Message>;
  route?: ChannelRoute<Message>;
  /** For adapters that keep state between webhooks. */
  state?: StateAdapter;
  /** The bot's name, for adapters that read it. */
  userName?: string;
  /**
   * For an adapter a Chat SDK `Chat` already owns (its webhooks and its
   * chat instance): how to make sure that `Chat` initialized it before a
   * send. The Channel then sends only, and takes no webhooks.
   */
  initialize?: () => Promise<void>;
};

type Capture = { events: Promise<ChannelIngressEnvelope<Message> | null>[] };

/**
 * Any Chat SDK adapter as a Channel: the adapter verifies and parses the
 * platform's webhooks and sends to its threads; Channels routes and answers.
 * The Channel is the adapter's chat instance: the messages the adapter
 * reports while it handles one webhook become that webhook's events. Other
 * reports (reactions, slash commands, modals) are not Channels events and
 * are dropped.
 *
 * @internal Not exported to apps until its first in-repo user ships.
 */
export function chatSdkChannel(
  options: ChatSdkChannelOptions
): Channel<Message> {
  const { adapter, name } = options;
  const capture = new AsyncLocalStorage<Capture>();
  let initialized: Promise<void> | undefined;

  const instance: ChatInstance = {
    getLogger: (prefix?: string) =>
      logger(`${name}${prefix ? `:${prefix}` : ""}`),
    getState: () => {
      if (!options.state) {
        throw new Error(
          `The ${name} adapter needs a state adapter: pass chatSdkChannel({ state })`
        );
      }
      return options.state;
    },
    getUserName: () => options.userName ?? name,
    handleIncomingMessage: async (_adapter, threadId, message) => {
      report(threadId, message);
    },
    processMessage: async (_adapter, threadId, message) => {
      report(threadId, message);
    },
    processAction: async () => {},
    processAppHomeOpened: () => {},
    processAssistantContextChanged: () => {},
    processAssistantThreadStarted: () => {},
    processMemberJoinedChannel: () => {},
    processModalClose: () => {},
    processModalSubmit: async () => undefined,
    processOptionsLoad: async () => undefined,
    processReaction: () => {},
    processSlashCommand: () => {},
    get transcripts(): ChatInstance["transcripts"] {
      throw new Error("Chat SDK transcripts are not available in Channels");
    }
  };

  function report(
    threadId: string,
    message: Message | (() => Promise<Message>)
  ): void {
    const current = capture.getStore();
    if (!current) return;
    current.events.push(
      (async () => {
        const parsed =
          typeof message === "function" ? await message() : message;
        if (parsed.author.isMe) return null;
        return { event: toEvent(adapter, name, threadId, parsed), raw: parsed };
      })()
    );
  }

  const send = async (
    surface: ChannelMessageSurface,
    post: (threadId: string) => Promise<{ id: string } | null>,
    started: (error: unknown) => boolean
  ): Promise<DeliveryResult> => {
    const threadId = threadOf(surface);
    if (!threadId) {
      return {
        status: "failed",
        retryable: false,
        error: {
          code: "CHANNEL_SURFACE_INVALID",
          message: "A Chat SDK surface names no thread"
        }
      };
    }
    try {
      await (initialized ??= options.initialize
        ? options.initialize()
        : adapter.initialize(instance));
      const sent = await post(threadId);
      return { status: "delivered", ...(sent && { reference: sent.id }) };
    } catch (error) {
      const failure = {
        code: "CHAT_SDK_SEND_FAILED",
        message: error instanceof Error ? error.message : String(error)
      };
      if (started(error)) return { status: "uncertain", error: failure };
      return { status: "failed", retryable: retryable(error), error: failure };
    }
  };

  return reportingPosting({
    ...(options.participant && { participant: options.participant }),
    ...(options.route && { route: options.route }),
    ...(options.participant &&
      !options.initialize && {
        ingress: {
          async receive(request) {
            if (!matchesPath(request, options.path)) return null;
            await (initialized ??= adapter.initialize(instance));
            const current: Capture = { events: [] };
            const response = await capture.run(current, () =>
              adapter.handleWebhook(request)
            );
            const events = (await Promise.all(current.events)).filter(
              (envelope): envelope is ChannelIngressEnvelope<Message> =>
                envelope !== null
            );
            return { events, response };
          }
        }
      }),
    deliver(surface, message) {
      return send(
        surface,
        (threadId) =>
          adapter.postMessage(threadId, { markdown: message.markdown }),
        () => false
      );
    },
    async stream(surface, chunks, options) {
      const text = textOf(chunks);
      const stream = adapter.stream;
      // A post landed: what reached the reader is unknown on a failure.
      let posted = false;
      // A post's call began: unknown too, unless the provider refused it.
      let sending = false;
      const beforePost = () => {
        posting(options);
        sending = true;
        return () => (posted = true);
      };
      const deltas = text.deltas[Symbol.asyncIterator]();
      const rest = { [Symbol.asyncIterator]: () => deltas };
      // Whether the adapter's stream read any of it.
      let read = false;
      async function* untilThePost(first: string): AsyncIterable<string> {
        read = true;
        yield first;
        yield* rest;
        // The adapter read it all: what it sends next is its post. Until
        // then it showed previews (Telegram's drafts), so a stream cut
        // short before here is streamed again in full. An adapter that
        // posts as it streams may then show a cut-off copy above it.
        beforePost();
      }
      const result = await send(
        surface,
        async (threadId) => {
          if (stream) {
            // Telegram refuses a stream without text: start it with the
            // first. A response with none posts nothing (or the notice).
            const first = await deltas.next();
            if (first.done) return postAndEdit(threadId, text, beforePost);
            const sent = await stream.call(
              adapter,
              threadId,
              untilThePost(first.value)
            );
            // An adapter that will not stream to this thread (Telegram
            // groups) returns null before it reads any text.
            if (sent !== null || read) {
              posted = true;
              return sent;
            }
            return postAndEdit(
              threadId,
              { ...text, deltas: prefixed(first.value, rest) },
              beforePost
            );
          }
          return postAndEdit(threadId, text, beforePost);
        },
        (error) => posted || (sending && !refused(error))
      );
      // The answer broke off after text went out: what there was is posted.
      return posted && text.interrupted() && result.status === "delivered"
        ? interruptedAnswer(result.reference)
        : result;
    }
  });

  /**
   * Post the first text as it arrives and edit the message as the rest
   * does, so a post starts with the answer, as a streamed one does. A
   * response with no text posts nothing, or the notice if it broke off.
   */
  async function postAndEdit(
    threadId: string,
    text: ReturnType<typeof textOf>,
    beforePost: () => () => void
  ): Promise<{ id: string } | null> {
    let markdown = "";
    let shown = "";
    let shownAt = 0;
    let sent: { id: string } | undefined;
    for await (const delta of text.deltas) {
      markdown += delta;
      // A message shows no trailing whitespace: what is shown is trimmed, so
      // "Got " then "Got it" is posted as "Got" and edited once.
      const visible = markdown.trimEnd();
      if (!sent) {
        // Telegram refuses a blank message: wait for the first real text.
        if (visible.length === 0) continue;
        const afterPost = beforePost();
        sent = await adapter.postMessage(threadId, { markdown: visible });
        afterPost();
      } else if (visible === shown || Date.now() - shownAt < EDIT_INTERVAL_MS) {
        continue;
      } else {
        await adapter.editMessage(threadId, sent.id, { markdown: visible });
      }
      shown = visible;
      shownAt = Date.now();
    }
    if (!sent) {
      if (!text.interrupted()) return null;
      beforePost();
      return adapter.postMessage(threadId, { markdown: INTERRUPTED_NOTICE });
    }
    const visible = markdown.trimEnd();
    if (shown !== visible) {
      const wait = shownAt + EDIT_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      await adapter.editMessage(threadId, sent.id, { markdown: visible });
    }
    return sent;
  }
}

/** The least time between two edits of a posted answer. */
const EDIT_INTERVAL_MS = 1000;

function interruptedAnswer(reference: string | undefined): DeliveryResult {
  return {
    status: "uncertain",
    ...(reference && { reference }),
    error: {
      code: "CHANNEL_STREAM_INTERRUPTED",
      message: "An incomplete answer was posted"
    }
  };
}

/**
 * A response's text deltas, as the adapter's `stream` takes them. A
 * response that breaks off ends the deltas there, without an error, so the
 * adapter still posts what it has; `interrupted()` says it broke off.
 */
async function* prefixed(
  first: string,
  rest: AsyncIterable<string>
): AsyncIterable<string> {
  yield first;
  yield* rest;
}

function textOf(chunks: ReadableStream<ResponseChunk>): {
  deltas: AsyncIterable<string>;
  started(): boolean;
  interrupted(): boolean;
} {
  let started = false;
  let interrupted = false;
  async function* deltas(): AsyncIterable<string> {
    const collect = createTextCollector();
    try {
      for await (const chunk of chunks) {
        const text = collect(chunk);
        if (text.length === 0) continue;
        started = true;
        yield text;
      }
    } catch (error) {
      // A later response answers: post nothing of this one.
      if (error instanceof SupersededResponse) throw error;
      interrupted = true;
    }
  }
  return {
    deltas: deltas(),
    started: () => started,
    interrupted: () => interrupted
  };
}

function toEvent(
  adapter: Adapter,
  name: string,
  threadId: string,
  message: Message
): ChannelIngressEventInput {
  const { author } = message;
  return {
    type: "message",
    // An edit is a new event for the same message.
    eventId: message.metadata.edited
      ? `${name}:${message.id}:edited:${message.metadata.editedAt?.getTime() ?? message.text}`
      : `${name}:${message.id}`,
    thread: {
      id: threadId,
      isDirectMessage: adapter.isDM ? adapter.isDM(threadId) : "unknown"
    },
    replySurface: {
      version: 1,
      address: { threadId } satisfies ChatSdkAddress,
      label: `${name} · ${threadId}`,
      key: threadId
    },
    actor: {
      id: `${name}:${author.userId}`,
      identity: { scope: name, subject: author.userId },
      ...(author.userName && { username: author.userName }),
      ...(author.fullName && { fullName: author.fullName }),
      isBot: author.isBot
    },
    message: {
      id: message.id,
      text: message.text,
      attachments: message.attachments.map((attachment) => ({
        ...(attachment.url !== undefined && { url: attachment.url }),
        ...(attachment.mimeType !== undefined && {
          mediaType: attachment.mimeType
        }),
        ...(attachment.name !== undefined && { name: attachment.name }),
        ...(attachment.size !== undefined && { size: attachment.size })
      })),
      ...(message.isMention !== undefined && { isMention: message.isMention }),
      metadata: {
        sentAt: message.metadata.dateSent.toISOString(),
        edited: message.metadata.edited,
        ...(message.metadata.editedAt && {
          editedAt: message.metadata.editedAt.toISOString()
        })
      }
    }
  };
}

function threadOf(surface: ChannelMessageSurface): string | undefined {
  const address = surface.address as Partial<ChatSdkAddress> | null;
  return typeof address?.threadId === "string" ? address.threadId : undefined;
}

/** A send that failed for a reason trying again will not change. */
/** The provider answered and refused the call, so it posted nothing. */
function refused(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status: unknown }).status)
      : undefined;
  if (status !== undefined && status >= 400 && status < 500) return true;
  const name = error instanceof Error ? error.name : "";
  return /RateLimit|Auth|Permission|NotFound|Validation/i.test(name);
}

function retryable(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status: unknown }).status)
      : undefined;
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return false;
  }
  const name = error instanceof Error ? error.name : "";
  return !/Auth|Permission|NotFound|Validation/i.test(name);
}

function logger(prefix: string): Logger {
  const line = (message: string) => `[${prefix}] ${message}`;
  return {
    child: (child) => logger(`${prefix}:${child}`),
    debug: () => {},
    info: () => {},
    warn: (message, ...args) => console.warn(line(message), ...args),
    error: (message, ...args) => console.error(line(message), ...args)
  };
}
