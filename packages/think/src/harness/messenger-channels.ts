/**
 * The harness-backed Think's messengers, on Channels: each messenger from
 * `getMessengers()` is a Chat SDK Channel (its adapter verifies and parses
 * the platform's webhooks), mounted with `Channels.forHarness` on the
 * class's `ThinkHarness`, its replies sent as delivery runs. A message joins
 * the harness's default session (`conversation: "self"`).
 *
 * Durable: nothing of its own (Channels' Streams and KV, the deliveries'
 * runs). In memory: the definitions.
 */

import type { ThinkHarness } from "agents/harness/think";
import { chatSdkChannel, deliverToSurfaces } from "agents/internal";
import {
  ChannelGateway,
  Channels,
  type ChannelMessageSurface,
  type ChannelsHost,
  type ConversationUpdate
} from "agents/experimental/channels";
import { Streams } from "agents/streams";
import type { Tasks } from "agents/tasks";
import { normalizeMessengers, type ThinkMessengers } from "../messengers";

/** @internal */
export type ThinkMessengerChannels = {
  readonly channels: Channels;
  /** Route a webhook to its messenger; `undefined` when none owns it. */
  receive(request: Request): Promise<Response | undefined>;
};

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
}): ThinkMessengerChannels | undefined {
  const definitions = normalizeMessengers(options.messengers);
  if (definitions.length === 0) return undefined;
  if (definitions.some((definition) => definition.id === TURNS_KEY)) {
    throw new Error(`"${TURNS_KEY}" is reserved and is not a messenger id`);
  }
  const ingress = definitions.map((definition) => {
    const channel = chatSdkChannel({
      adapter: definition.adapter,
      name: definition.adapterName,
      path: definition.path,
      participant: (event) => event.actor?.id ?? null,
      ...(definition.userName && { userName: definition.userName })
    });
    return { definition, channel };
  });
  /**
   * The deliveries' first attempts of each operation some webhook waits on,
   * shared by every webhook for it (a retried webhook waits for what the
   * first one started), with the count of those webhooks.
   */
  const attempts = new Map<
    string,
    { started: Promise<void>[]; waiting: number }
  >();
  /** Each waiting webhook's operations, told when Channels settles the turn. */
  const settled = new Map<string, Set<() => void>>();
  let turnsHost: ChannelsHost | undefined;
  /**
   * Watch `operation`'s turn from before Channels takes it. `settled()`
   * resolves once Channels settled the turn, after every update before it
   * was published (so the turn's deliveries started). It waits for the
   * harness first; a turn Channels settled already (a repeated webhook) is
   * no longer in its snapshot.
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
      // (so its deliveries started), for the webhook that waits on it.
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
      ...ingress.map(({ definition, channel }) => [
        definition.id,
        deliverToSurfaces(channel, {
          tasks: options.tasks,
          // Every thread shares the default session, as in Think: a reply
          // goes to the thread whose message started its turn, only.
          asker: (startedBy) =>
            options.kv.get<ChannelMessageSurface>(askerKey(startedBy)),
          sending: (startedBy, attempt) =>
            attempts.get(startedBy)?.started.push(attempt)
        })
      ])
    ])
  });
  const gatewayChannels = Object.fromEntries(
    ingress.map(({ definition, channel }) => [definition.id, channel])
  );
  return {
    channels,
    async receive(request) {
      if (!options.root()) return undefined;
      // Think's webhook check comes first, as in Think: a request it refuses
      // never reaches the adapter.
      const pathname = new URL(request.url).pathname;
      const definition = definitions.find((d) => d.path === pathname);
      if (!definition) return undefined;
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (definition.verifyWebhook !== false) {
        const verdict = await definition.verifyWebhook(
          request.clone() as Request
        );
        if (verdict instanceof Response) return verdict;
        if (verdict === false) {
          return new Response("Unauthorized", { status: 401 });
        }
      }
      // The gateway's own code authenticates and normalizes the webhook and
      // hands its events to this object's Channels, every sender to this
      // agent, as Think's messengers answer here.
      const operations: string[] = [];
      const turns = new Map<string, TurnWatch>();
      const gateway = new ChannelGateway({
        channels: gatewayChannels,
        agent: () => ({
          receive: async (event, origin) => {
            operations.push(event.eventId);
            const shared = attempts.get(event.eventId) ?? {
              started: [],
              waiting: 0
            };
            shared.waiting += 1;
            attempts.set(event.eventId, shared);
            // Watched before Channels takes it, so its settling is seen.
            turns.set(event.eventId, watchTurn(event.eventId));
            options.kv.put(askerKey(event.eventId), origin.surface);
            await channels.receive(event, origin);
          },
          fetch: () =>
            Promise.resolve(new Response("Not found", { status: 404 }))
        })
      });
      try {
        const response = await gateway.fetch(request);
        // As in Think, the webhook answers once its replies are sent: each
        // turn it started ends, then its deliveries' first attempts do (one
        // that failed and waits to retry is not waited for).
        for (const operation of operations) {
          await turns.get(operation)?.settled();
          await Promise.all(attempts.get(operation)?.started ?? []);
          // Also here: a retried webhook's turn settled before it came, and
          // will not settle again.
          options.kv.delete(askerKey(operation));
        }
        return response;
      } finally {
        for (const operation of operations) {
          const shared = attempts.get(operation);
          if (shared && --shared.waiting === 0) attempts.delete(operation);
        }
        for (const turn of turns.values()) turn.release();
      }
    }
  };
}

type TurnWatch = { settled(): Promise<void>; release(): void };

/** The key of the Channel that watches turns settle; not a messenger id. */
const TURNS_KEY = "think:turns";

function askerKey(eventId: string): string {
  return `cf_think_messenger_asker:${eventId}`;
}
