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
import { collectText, createTextCollector } from "../stream";
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
    started: () => boolean
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
      await (initialized ??= adapter.initialize(instance));
      const sent = await post(threadId);
      return { status: "delivered", ...(sent && { reference: sent.id }) };
    } catch (error) {
      const failure = {
        code: "CHAT_SDK_SEND_FAILED",
        message: error instanceof Error ? error.message : String(error)
      };
      if (started()) return { status: "uncertain", error: failure };
      return { status: "failed", retryable: retryable(error), error: failure };
    }
  };

  return {
    ...(options.participant && { participant: options.participant }),
    ...(options.route && { route: options.route }),
    ...(options.participant && {
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
    async stream(surface, chunks) {
      const stream = adapter.stream;
      if (!stream) {
        const collected = await collectText(chunks);
        const result = await send(
          surface,
          (threadId) =>
            adapter.postMessage(threadId, { markdown: collected.text }),
          () => false
        );
        return collected.interrupted && result.status === "delivered"
          ? {
              status: "uncertain",
              ...(result.reference && { reference: result.reference }),
              error: {
                code: "CHANNEL_STREAM_INTERRUPTED",
                message: "An incomplete answer was posted"
              }
            }
          : result;
      }
      let started = false;
      return send(
        surface,
        (threadId) =>
          stream.call(
            adapter,
            threadId,
            textOf(chunks, () => (started = true))
          ),
        () => started
      );
    }
  };
}

/** A response's text deltas, as the adapter's `stream` takes them. */
async function* textOf(
  chunks: ReadableStream<ResponseChunk>,
  onFirst: () => void
): AsyncIterable<string> {
  const collect = createTextCollector();
  for await (const chunk of chunks) {
    const text = collect(chunk);
    if (text.length === 0) continue;
    onFirst();
    yield text;
  }
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
    eventId: `${name}:${message.id}`,
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
