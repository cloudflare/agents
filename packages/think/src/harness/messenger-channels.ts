/**
 * The harness-backed Think's messengers, on Channels. Each messenger from
 * `getMessengers()` takes its webhooks through Think's Chat SDK `Chat` (the
 * release's state rows: subscriptions, thread locks, queued messages),
 * which decides what is answered. Each answered event joins the harness's
 * default session through `Channels.forHarness`, as `conversation: "self"`
 * does in Think, and its reply goes out through the messenger's Chat SDK
 * Channel as a delivery run, to the asking thread only.
 *
 * Durable: each turn's asker in KV until the turn settles (with Chat SDK
 * state, Channels' Streams and KV, and the deliveries' runs). In memory:
 * the definitions, the `Chat`, and the turns webhooks wait on.
 */

import type { UIMessage } from "ai";
import type { Adapter, Chat } from "chat";
import type { ThinkHarness } from "agents/harness/think";
import { chatSdkChannel, deliverToSurfaces } from "agents/internal";
import {
  Channels,
  type ChannelMessageSurface,
  type ChannelsHost,
  type ConversationUpdate
} from "agents/experimental/channels";
import { Streams } from "agents/streams";
import type { Tasks } from "agents/tasks";
import {
  createMessengerChat,
  idempotencyKeyForEvent,
  normalizeMessengers,
  withMessengerQueueTtl,
  type MessengerConcurrency,
  type NormalizedMessengerDefinition,
  type ThinkMessengers
} from "../messengers/chat-sdk";
import {
  toMessengerUserMessage,
  type MessengerEvent
} from "../messengers/events";

/** @internal */
export type ThinkMessengerChannels = {
  readonly channels: Channels;
  /** Take a webhook for a messenger; `undefined` when none owns its path. */
  receive(request: Request): Promise<Response | undefined>;
};

type ChannelEvent = Parameters<Channels["receive"]>[0];
type MessagePart = Extract<
  ChannelEvent,
  { type: "message" }
>["message"]["parts"][number];

/**
 * The messengers as Channels, or `undefined` when there are none. Only the
 * root object takes their webhooks, as in Think; whether this one is the
 * root is known only once it started (a sub-agent learns its path then), so
 * it is asked per request, and a sub-agent's Channels stay idle.
 *
 * @internal
 */
export function messengerChannels(options: {
  messengers: ThinkMessengers;
  harness: ThinkHarness;
  tasks: Tasks;
  /** Whether this object is the root, not a sub-agent. */
  root(): boolean;
  /** Where each turn's asker is kept, so a reply after a reset finds it. */
  kv: SyncKvStorage;
  /** The Think object: Chat SDK state lives on its sub-agents. */
  parent: unknown;
  /** Read when the first webhook arrives, as Think reads it at start. */
  concurrency(): MessengerConcurrency;
}): ThinkMessengerChannels | undefined {
  const definitions = normalizeMessengers(options.messengers);
  if (definitions.length === 0) return undefined;
  if (definitions.some((definition) => definition.id === TURNS_KEY)) {
    throw new Error(`"${TURNS_KEY}" is reserved and is not a messenger id`);
  }
  /**
   * The deliveries' first attempts of each operation, collected for every
   * answer waiting on it.
   */
  const attempts = new Map<string, Set<Promise<void>[]>>();
  /** Each waiting answer's operation, told when Channels settles the turn. */
  const settled = new Map<string, Set<() => void>>();
  let turnsHost: ChannelsHost | undefined;

  /**
   * Watch `operation`'s turn from before Channels takes it. `settled()`
   * resolves once Channels settled the turn, after every update before it
   * was published (so the turn's deliveries started). It waits for the
   * harness first; a turn Channels settled already (a repeated event) is no
   * longer in its snapshot.
   */
  function watchTurn(operation: string): TurnWatch {
    let resolve!: () => void;
    const seen = new Promise<void>((r) => (resolve = r));
    const waiters = settled.get(operation) ?? new Set();
    settled.set(operation, waiters.add(resolve));
    const release = () => {
      waiters.delete(resolve);
      if (waiters.size === 0 && settled.get(operation) === waiters) {
        settled.delete(operation);
      }
    };
    return {
      release,
      async settled() {
        try {
          await options.harness.session().wait(operation);
          const host = turnsHost;
          const snapshot =
            host && (await host.snapshot(host.defaultConversation()));
          const open = snapshot?.turns.some(
            (turn) => turn.startedBy === operation && turn.status !== "settled"
          );
          if (open) await seen;
        } finally {
          release();
        }
      }
    };
  }

  const channels = Channels.forHarness(options.harness, {
    streams: new Streams({ name: "think-messengers" }),
    channels: Object.fromEntries([
      // Sees each turn settle after every update before it was published
      // (so its deliveries started), for the answer that waits on it.
      [
        TURNS_KEY,
        {
          mount(host: ChannelsHost) {
            turnsHost = host;
          },
          publish(_conversationId: string, update: ConversationUpdate) {
            if (update.type === "turn" && update.turn.status === "settled") {
              // Its replies have started: the asker is not read again.
              options.kv.delete(askerKey(update.turn.startedBy));
              for (const resolve of settled.get(update.turn.startedBy) ?? []) {
                resolve();
              }
            }
          }
        }
      ],
      ...definitions.map((definition) => [
        definition.id,
        deliverToSurfaces(
          chatSdkChannel({
            adapter: definition.adapter,
            name: definition.adapterName,
            path: definition.path,
            // The Chat below owns the adapter's webhooks and its chat
            // instance; this Channel only sends.
            initialize: () => chat().initialize(),
            ...(definition.userName && { userName: definition.userName })
          }),
          {
            tasks: options.tasks,
            // Every thread shares the default session, as in Think: a reply
            // goes to the thread whose message started its turn, only.
            asker: (startedBy) =>
              options.kv.get<ChannelMessageSurface>(askerKey(startedBy)),
            sending: (startedBy, attempt) =>
              attempts.get(startedBy)?.forEach((mine) => mine.push(attempt))
          }
        )
      ])
    ])
  });

  /**
   * Answer one event the Chat routed here: it joins the default session,
   * and the handler (holding the thread's lock, as in Think) returns once
   * Channels settled the turn and its deliveries' first attempts ended (one
   * that failed and waits to retry is not waited for).
   */
  async function answer(
    definition: NormalizedMessengerDefinition,
    event: MessengerEvent
  ): Promise<void> {
    const eventId = idempotencyKeyForEvent(event);
    const author = event.message?.author ?? event.action?.user;
    const threadId = event.thread.id;
    const surface: ChannelMessageSurface = {
      channelKey: definition.id,
      version: 1,
      address: { threadId },
      label: `${definition.adapterName} · ${threadId}`,
      key: threadId
    };
    const mine: Promise<void>[] = [];
    const waiting = attempts.get(eventId) ?? new Set();
    attempts.set(eventId, waiting.add(mine));
    // Watched before Channels takes it, so its settling is seen.
    const turn = watchTurn(eventId);
    try {
      options.kv.put(askerKey(eventId), surface);
      await channels.receive(
        {
          type: "message",
          eventId,
          message: {
            id: eventId,
            role: "user",
            parts: messageParts(
              toMessengerUserMessage(event, definition.channelSpeakerLabel)
            )
          }
        },
        {
          route: definition.id,
          participant: {
            id: `${definition.adapterName}:${author?.userId ?? "unknown"}`
          },
          surface
        }
      );
      await turn.settled();
      await Promise.all(mine);
      // Also here: a repeated event's turn settled before it came, and will
      // not settle again.
      options.kv.delete(askerKey(eventId));
    } finally {
      turn.release();
      waiting.delete(mine);
      if (waiting.size === 0 && attempts.get(eventId) === waiting) {
        attempts.delete(eventId);
      }
    }
  }

  let made: Chat<Record<string, Adapter>> | undefined;
  const chat = () =>
    (made ??= createMessengerChat({
      definitions,
      concurrency: withMessengerQueueTtl(options.concurrency()),
      parent: options.parent,
      onEvent: (definition, event) => answer(definition, event)
    }));

  return {
    channels,
    async receive(request) {
      if (!options.root()) return undefined;
      const pathname = new URL(request.url).pathname;
      const definition = definitions.find((d) => d.path === pathname);
      if (!definition) return undefined;
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      // Think's webhook check comes first: a request it refuses never
      // reaches the adapter.
      if (definition.verifyWebhook !== false) {
        const verdict = await definition.verifyWebhook(
          request.clone() as Request
        );
        if (verdict instanceof Response) return verdict;
        if (verdict === false) {
          return new Response("Unauthorized", { status: 401 });
        }
      }
      return chat().webhooks[definition.adapterName](request);
    }
  };
}

type TurnWatch = { settled(): Promise<void>; release(): void };

/** The key of the Channel that watches turns settle; not a messenger id. */
const TURNS_KEY = "think:turns";

function askerKey(eventId: string): string {
  return `cf_think_messenger_asker:${eventId}`;
}

/** The user message Think builds for an event, as Channels message parts. */
function messageParts(message: UIMessage): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const part of message.parts) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    else if (part.type === "file") {
      parts.push({
        type: "file",
        url: part.url,
        mediaType: part.mediaType,
        ...(part.filename !== undefined && { filename: part.filename })
      });
    }
  }
  return parts;
}
