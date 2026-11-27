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
import {
  chatSdkChannel,
  deliverToSurfaces,
  deliveryDefinition,
  registerDeliverySink,
  releaseDelivery,
  sendDelivery
} from "agents/internal";
import {
  CHAT_RECOVERY_INCIDENT_KEY_PREFIX,
  type ChatRecoveryIncident
} from "agents/chat";
import {
  migrateLegacyRecoveredReplies,
  RECOVERED_REPLY_SINK,
  recoveredReplyId,
  recoveredReplyOutcome,
  recoveredReplySink,
  type RecoveredReplyClaim
} from "../messengers/recovered-reply";
import {
  Channels,
  type ChannelMessageSurface,
  type ChannelsHost,
  type ConversationUpdate
} from "agents/experimental/channels";

/** A Channels turn's status, from its update. */
type TurnStatus = Extract<ConversationUpdate, { type: "turn" }>["turn"];

/** A message's text, its text parts joined. */
function messageText(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}
import { Streams } from "agents/streams";
import type { Tasks } from "agents/tasks";
import {
  createMessengerChat,
  drainStrandedQueue,
  idempotencyKeyForEvent,
  normalizeMessengers,
  recoveredReplyPosts,
  withMessengerQueueTtl,
  type MessengerConcurrency,
  type NormalizedMessengerDefinition,
  type ThinkMessengers
} from "../messengers/chat-sdk";
import {
  INTERRUPTED_MESSENGER_RESPONSE,
  messengerReplyRecoveryMode,
  reviveMessengerEvent
} from "../messengers/delivery";
import {
  RELEASED_REPLY_DEFINITION,
  releasedSnapshot
} from "../messengers/reply-task";
import {
  messengerContextFromEvent,
  toMessengerUserMessage,
  type MessengerContext,
  type MessengerEvent
} from "../messengers/events";

/** @internal */
export type ThinkMessengerChannels = {
  readonly channels: Channels;
  /** Take a webhook for a messenger; `undefined` when none owns its path. */
  receive(request: Request): Promise<Response | undefined>;
  /** The messengers' ids. */
  readonly ids: readonly string[];
  /**
   * The messenger whose webhook sent user message `messageId`, while its
   * turn runs (the message's id is its event's).
   */
  channelOf(messageId: string): string | undefined;
  /** The messenger context of user message `messageId`, while its turn runs. */
  contextOf(messageId: string): MessengerContext | undefined;
  /**
   * TEMPORARY: remove in the next minor. Deliver the recovered replies
   * think@0.24.0 kept under `cf_think_messenger_recovery:`. Called at start.
   */
  importReleasedReplies(): Promise<void>;
  /**
   * TEMPORARY: remove in the next minor. Release the reply held for a
   * think@0.24.0 recovery incident with its outcome.
   */
  releaseReleasedReply(
    incidentId: string,
    outcome: "completed" | "interrupted",
    text?: string
  ): Promise<void>;
  /** Where a notice to messenger `id`'s `thread` is posted, if anywhere. */
  noticeSurface(
    id: string,
    thread: string | undefined
  ):
    | { post(text: string | { markdown: string }): Promise<unknown> }
    | undefined;
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
  /** Where think@0.24.0 kept the replies it left unfinished. */
  storage: DurableObjectStorage;
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
  const streams = new Streams({ name: "think-messengers" });
  /** Each running turn's first response in this isolate. */
  const firstResponses = new Map<string, string>();
  /**
   * Turns whose model call failed and was tried again in this isolate, with
   * what their first attempt had written: the later attempts are not
   * delivered live, but posted once the turn settles, as Think posts a
   * recovered reply (the rest of the answer, the apology, or the
   * empty-response text). A reset's rerun, in a new isolate, streams.
   */
  const retried = new Map<string, Promise<string>>();

  /** The text of saved message `id`, or "" when there is none. */
  async function textOf(id: string | undefined): Promise<string> {
    if (id === undefined) return "";
    const messages = await options.harness.session().messages();
    return messageText(messages.find((message) => message.id === id));
  }

  /** The text response `responseId` streamed (what went out live). */
  async function partialText(responseId: string): Promise<string> {
    let text = "";
    for await (const { chunk } of streams.read(responseId)) {
      const delta = chunk as { type?: unknown; delta?: unknown };
      if (delta.type === "text-delta" && typeof delta.delta === "string") {
        text += delta.delta;
      }
    }
    return text;
  }

  /** Post a retried turn's reply to its asker, as Think posts a recovered one. */
  async function postRetried(
    asker: ChannelMessageSurface,
    turn: Extract<TurnStatus, { status: "settled" }>,
    partial: Promise<string>
  ): Promise<void> {
    const definition = definitions.find((d) => d.id === asker.channelKey);
    const threadId = (asker.address as { threadId?: unknown }).threadId;
    if (!definition || typeof threadId !== "string") return;
    const posted = await partial;
    const text = await textOf(turn.messageIds.at(-1));
    const posts = recoveredReplyPosts(definition, {
      outcome: turn.outcome === "failed" ? "interrupted" : "completed",
      text: text.startsWith(posted) ? text.slice(posted.length) : text,
      partialPosted: posted.trim().length > 0
    });
    await chat().initialize();
    for (const post of posts) {
      await definition.adapter.postMessage(threadId, post);
    }
  }

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
    streams,
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
            if (update.type === "turn" && update.turn.status === "running") {
              const { startedBy, responseId } = update.turn;
              const first = firstResponses.get(startedBy);
              if (first === undefined) {
                firstResponses.set(startedBy, responseId);
              } else if (
                first !== responseId &&
                !retried.has(startedBy) &&
                // Its webhook still waits here: the model call failed and
                // was tried again. A reset's rerun has no live webhook.
                attempts.has(startedBy)
              ) {
                retried.set(startedBy, partialText(first));
              }
            }
            if (update.type === "turn" && update.turn.status === "settled") {
              const startedBy = update.turn.startedBy;
              firstResponses.delete(startedBy);
              const partial = retried.get(startedBy);
              retried.delete(startedBy);
              const kept = options.kv.get<ChannelMessageSurface>(
                askerKey(startedBy)
              );
              if (partial && kept) {
                const posting = postRetried(kept, update.turn, partial);
                // The answer that waits on the turn waits on this too.
                const waiting = attempts.get(startedBy);
                if (waiting) {
                  for (const mine of waiting) mine.push(posting);
                } else {
                  void posting.catch((error: unknown) =>
                    console.error(
                      "[Think] A retried reply was not posted",
                      error
                    )
                  );
                }
              }
              // A turn no webhook here waits on is one a reset cut off and
              // the harness ran again: the Chat handler that held its thread
              // died with the reset, so what queued behind it is drained, as
              // Think drains it after recovering a reply.
              const asker = options.kv.get<ChannelMessageSurface>(
                askerKey(startedBy)
              );
              if (asker && !attempts.has(startedBy)) {
                drainLater(asker);
              }
              // Its replies have started: the asker is not read again.
              options.kv.delete(askerKey(startedBy));
              options.kv.delete(contextKey(startedBy));
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
              retried.has(startedBy)
                ? undefined
                : options.kv.get<ChannelMessageSurface>(askerKey(startedBy)),
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
      // As in Think, the turn's messenger context, from the event.
      options.kv.put(contextKey(eventId), messengerContextFromEvent(event));
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
      options.kv.delete(contextKey(eventId));
    } finally {
      turn.release();
      waiting.delete(mine);
      if (waiting.size === 0 && attempts.get(eventId) === waiting) {
        attempts.delete(eventId);
      }
    }
  }

  // TEMPORARY: remove in the next minor after this ships. A reply
  // think@0.24.0 left unfinished: answered again if no text of it went out,
  // apologized for if some did, as Think does; a completed one posts
  // nothing more.
  options.tasks.register(RELEASED_REPLY_DEFINITION, async (_input, step) => {
    const key = `__cf_messenger_recovery:${step.id}`;
    const snapshot = releasedSnapshot(await options.storage.get(key));
    const event = snapshot && reviveMessengerEvent(snapshot.event);
    const definition =
      event && definitions.find((d) => d.id === event.messengerId);
    if (snapshot && event && definition) {
      const mode = messengerReplyRecoveryMode(snapshot.stage);
      if (mode === "answer") await answer(definition, event);
      if (mode === "apologize") {
        await chat().initialize();
        await definition.adapter.postMessage(event.thread.id, {
          markdown:
            definition.delivery?.interruptedResponseText ??
            INTERRUPTED_MESSENGER_RESPONSE
        });
      }
    }
    await options.storage.delete(key);
  });

  // TEMPORARY: remove in the next minor. A recovered reply think@0.24.0
  // kept is posted as Think posts it: the rest of a settled one, from its
  // cursor, and the apology for one left unsettled, since the previous
  // engine's recovery that would settle it does not run after the move.
  registerDeliverySink(
    options.tasks,
    RECOVERED_REPLY_SINK,
    recoveredReplySink(async () => async (input) => {
      const definition = definitions.find((d) => d.id === input.messengerId);
      if (!definition) return { chunks: 0 };
      const posts = recoveredReplyPosts(definition, input);
      const post = posts[input.chunk];
      if (post !== undefined) {
        await chat().initialize();
        await definition.adapter.postMessage(input.threadId, post);
      }
      return { chunks: posts.length };
    })
  );

  /** Whether a think@0.24.0 recovery incident is over (or never was). */
  async function incidentGone(incidentId: string): Promise<boolean> {
    const incident = await options.storage.get<ChatRecoveryIncident>(
      CHAT_RECOVERY_INCIDENT_KEY_PREFIX + encodeURIComponent(incidentId)
    );
    return (
      !incident ||
      incident.status === "skipped" ||
      incident.status === "exhausted"
    );
  }

  /** Release the reply held for `incidentId`, as Think releases it. */
  async function release(
    incidentId: string,
    outcome: "completed" | "interrupted",
    text?: string
  ): Promise<void> {
    const id = recoveredReplyId(incidentId);
    const claim = options.tasks.inputOf<RecoveredReplyClaim>(id);
    if (!claim) return;
    await releaseDelivery(
      options.tasks,
      id,
      recoveredReplyOutcome(claim, outcome, text)
    );
  }

  /** Drain the thread `asker` names, in the background. */
  function drainLater(asker: ChannelMessageSurface): void {
    const definition = definitions.find((d) => d.id === asker.channelKey);
    const threadId = (asker.address as { threadId?: unknown }).threadId;
    if (!definition || typeof threadId !== "string") return;
    const drain = () => drainStrandedQueue(chat(), definition, threadId);
    const keepAlive = (
      options.parent as {
        keepAliveWhile?: <T>(fn: () => Promise<T>) => Promise<T>;
      }
    ).keepAliveWhile;
    const running = keepAlive ? keepAlive.call(options.parent, drain) : drain();
    void running.catch((error: unknown) => {
      console.error(
        `[Think] Failed to drain messages queued on ${threadId} after a reset`,
        error
      );
    });
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
    ids: definitions.map((definition) => definition.id),
    channelOf(messageId) {
      return options.kv.get<ChannelMessageSurface>(askerKey(messageId))
        ?.channelKey;
    },
    contextOf(messageId) {
      return options.kv.get<MessengerContext>(contextKey(messageId));
    },
    async importReleasedReplies() {
      // As Think moves them: settled ones are delivered; one whose incident
      // still recovers is held, at once, so a release finds it; the rest
      // are apologized for.
      await migrateLegacyRecoveredReplies(
        options.storage,
        incidentGone,
        (id, claim, progress) =>
          progress.outcome === undefined
            ? sendDelivery(options.tasks, RECOVERED_REPLY_SINK, id, claim)
            : sendDelivery(options.tasks, RECOVERED_REPLY_SINK, id, claim, {
                sentAt: Date.now(),
                attempts: 0,
                progress
              })
      );
      // A held reply whose incident is gone: nothing will release it now.
      const prefix = recoveredReplyId("");
      for (const held of options.tasks.peekList({
        definition: deliveryDefinition(RECOVERED_REPLY_SINK),
        status: ["pending"],
        parked: true,
        results: false
      })) {
        const incidentId = held.runId.slice(prefix.length);
        if (await incidentGone(incidentId)) {
          await release(incidentId, "interrupted");
        }
      }
    },
    releaseReleasedReply: (incidentId, outcome, text) =>
      release(incidentId, outcome, text),
    noticeSurface(id, thread) {
      const definition = definitions.find((d) => d.id === id);
      if (!definition || thread === undefined) return undefined;
      return {
        async post(text) {
          await chat().initialize();
          // A string goes as plain text, as Think posts it.
          return definition.adapter.postMessage(thread, text);
        }
      };
    },
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

function contextKey(eventId: string): string {
  return `cf_think_messenger_context:${eventId}`;
}

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
