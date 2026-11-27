import { registerDeliverySink, sendDelivery } from "../../internal/delivery";
import { NonRetryableError } from "../../tasks/errors";
import type { Tasks } from "../../tasks/tasks";
import type { Channel, ChannelStreamOptions, DeliveryResult } from "./channel";
import type {
  ChannelsHost,
  ConversationChannel,
  ConversationUpdate
} from "./conversations";
import type { ResponseChunk } from "./protocol";
import { collectText } from "./stream";
import type { ChannelMessageSurface } from "./surface";

/** One response on its way to one surface: a delivery run's payload. */
type SurfaceDelivery = {
  conversationId: string;
  responseId: string;
  surface: ChannelMessageSurface;
};

/** @internal */
export type DeliverToSurfacesOptions = {
  /**
   * The Tasks capability the deliveries run on: the agent's own
   * (`this.tasks`), or one the host installs.
   */
  tasks: Tasks;
  /**
   * Send each response only to the surface that asked: given the event id
   * that started the response's turn, its surface, or `undefined` to send it
   * nowhere. A surface of another Channel is not sent to. Default: every
   * surface of this Channel that joined the conversation.
   */
  asker?(
    startedBy: string
  ):
    | ChannelMessageSurface
    | undefined
    | Promise<ChannelMessageSurface | undefined>;
  /**
   * Told of each delivery as it starts, with the event id that started the
   * response's turn and a promise that settles when its first attempt ends
   * (delivered, or failed and waiting to retry).
   */
  sending?(startedBy: string, firstAttempt: Promise<void>): void;
};

/** Checkpoint key: a provider call of this delivery may have started. */
const POSTING = "posting";

/**
 * Serve a gateway Channel that sends (email today) inside the agent: every
 * response of a conversation goes to each of that Channel's surfaces that
 * joined it, as a durable delivery run. Mount it under the key the
 * Channel has in the gateway, so the surfaces it serves are the ones the
 * gateway recorded:
 *
 * ```ts
 * readonly channels = Channels.forHarness(this.harness, {
 *   channels: {
 *     web: new WebChannel(),
 *     email: deliverToSurfaces(email({ binding: env.EMAIL, from }), {
 *       tasks: this.tasks
 *     })
 *   }
 * });
 * ```
 *
 * A Channel that streams gets the response as it is produced; one that
 * cannot gets it once it has ended (the provider is called then, so a long
 * generation does not count against its attempt): what the response
 * produced, a short notice when it was interrupted before any text, and
 * nothing for a response that ended with no text. A delivery is tried again with backoff while the Channel says the
 * failure is retryable. It is given up, and never posted twice, when the Channel
 * refuses it, when only part of it may have reached the reader
 * (`uncertain`), and when the object reset while it was being posted.
 *
 * @internal Not exported to apps until its first in-repo user ships.
 */
export function deliverToSurfaces(
  channel: Channel,
  options: DeliverToSurfacesOptions
): ConversationChannel {
  let mounted: { host: ChannelsHost; sink: string } | undefined;
  return {
    mount(host) {
      if (mounted) {
        throw new Error("deliverToSurfaces() can be mounted only once");
      }
      if (!channel.stream && !channel.deliver) {
        throw new Error(
          `Channel "${host.channelKey}" can neither stream nor deliver`
        );
      }
      const sink = `channels:${host.channelKey}`;
      mounted = { host, sink };
      registerDeliverySink<SurfaceDelivery>(options.tasks, sink, {
        // An attempt follows the response while it is generated: a streamed
        // post lasts that long, and a collected one waits that long.
        attemptTimeoutMs: RESPONSE_TIMEOUT_MS,
        deliver: async (delivery, attempt) => {
          if (attempt.checkpoint.get(POSTING) === true) {
            // An attempt the object's reset cut short may have posted part
            // of the response: another would post it again.
            throw new NonRetryableError(
              "An earlier attempt may have posted part of this response"
            );
          }
          const result = await post(channel, host, delivery, () =>
            attempt.checkpoint.set(POSTING, true)
          );
          if (result === undefined) return;
          // The Channel answered: what reached the reader is known.
          attempt.checkpoint.set(POSTING, false);
          if (result.status === "delivered") return;
          const failure = `${result.error.code}: ${result.error.message}`;
          if (result.status === "failed" && result.retryable) {
            throw new Error(failure);
          }
          throw new NonRetryableError(
            result.status === "uncertain" && result.reference
              ? `${failure} (reference ${result.reference})`
              : failure
          );
        },
        onGiveUp: (error, delivery) => {
          console.error(
            `[channels] response ${delivery.responseId} was not delivered to ${delivery.surface.label}`,
            error
          );
        }
      });
    },
    async publish(conversationId, update) {
      const responseId = startedResponse(update);
      if (!mounted || !responseId || update.type !== "turn") return;
      const { host, sink } = mounted;
      const surfaces = options.asker
        ? [await options.asker(update.turn.startedBy)].filter(
            // The asker may have written through another Channel.
            (surface): surface is ChannelMessageSurface =>
              surface?.channelKey === host.channelKey
          )
        : await host.surfaces(conversationId);
      for (const surface of surfaces) {
        const id = `${sink}:${responseId}:${await surfaceKeyOf(surface)}`;
        // Not awaited: the first attempt streams the whole response.
        const firstAttempt = sendDelivery<SurfaceDelivery>(
          options.tasks,
          sink,
          id,
          { conversationId, responseId, surface }
        ).catch((error: unknown) => {
          console.error(`[channels] could not send ${id}`, error);
        });
        options.sending?.(update.turn.startedBy, firstAttempt);
      }
    }
  };
}

/** Channels that say themselves when a stream puts something in front of the reader. */
const reportsPosting = new WeakSet<Channel>();
/** The mark for one attempt, keyed by the options that attempt passes. */
const postingMarks = new WeakMap<object, () => void>();

/**
 * Declare that `channel`'s `stream` calls {@link posting} before it posts
 * anything a reader sees, so an attempt cut short before then is retried
 * rather than taken as possibly posted. Previews that a later post replaces
 * (Telegram's drafts) are not posts.
 *
 * @internal
 */
export function reportingPosting<C extends Channel>(channel: C): C {
  reportsPosting.add(channel);
  return channel;
}

/**
 * Run `mark` when the {@link reportingPosting} Channel streaming with
 * `options` says it is about to post.
 *
 * @internal
 */
export function onPosting(
  options: ChannelStreamOptions,
  mark: () => void
): void {
  postingMarks.set(options, mark);
}

/**
 * Called by a {@link reportingPosting} Channel just before a provider call
 * that may put text in front of the reader.
 *
 * @internal
 */
export function posting(options: ChannelStreamOptions): void {
  postingMarks.get(options)?.();
}

/**
 * What a response's stream fails with when its turn went on in a later
 * response (its run was cut and rerun): a Channel posts nothing of it, and
 * lets the attempt fail, so the delivery tried again reads it as empty.
 *
 * @internal
 */
export class SupersededResponse extends Error {
  constructor(responseId: string) {
    super(`Response ${responseId} was superseded by a later one`);
    this.name = "SupersededResponse";
  }
}

/** Sent for a response interrupted before it produced any text. */
export const INTERRUPTED_NOTICE =
  "The answer was interrupted before it could be written. Please ask again.";

/** How long one attempt may take: the answer's whole generation. */
const RESPONSE_TIMEOUT_MS = 60 * 60 * 1000;

/** The response a turn update starts, if it starts one. */
function startedResponse(update: ConversationUpdate): string | undefined {
  return update.type === "turn" && update.turn.status === "running"
    ? update.turn.responseId
    : undefined;
}

/**
 * Post one response to one surface: streamed, or collected and delivered.
 * `sending` runs just before the provider call. Returns `undefined` when
 * there was nothing to send (a response with no text).
 */
async function post(
  channel: Channel,
  host: ChannelsHost,
  { conversationId, responseId, surface }: SurfaceDelivery,
  sending: () => void
): Promise<DeliveryResult | undefined> {
  const chunks = readResponse(host, conversationId, responseId);
  const options: ChannelStreamOptions = {
    delivery: { deliveryId: responseId }
  };
  if (channel.stream) {
    let marked = false;
    const mark = () => {
      marked = true;
      sending();
    };
    const reports = reportsPosting.has(channel);
    if (reports) onPosting(options, mark);
    else mark();
    try {
      return await channel.stream(surface, chunks, options);
    } catch (error) {
      if (!marked) {
        // It said it had posted nothing yet.
        return {
          status: "failed",
          retryable: true,
          error: { code: "CHANNEL_STREAM_THREW", message: String(error) }
        };
      }
      // A Channel should finalize and say what reached the reader; one that
      // threw mid-stream may have posted part of it.
      return {
        status: "uncertain",
        error: { code: "CHANNEL_STREAM_THREW", message: String(error) }
      };
    }
  }
  const collected = await collectText(chunks);
  const text =
    collected.text.trim().length > 0
      ? collected.text
      : collected.interrupted
        ? INTERRUPTED_NOTICE
        : undefined;
  if (text === undefined) return undefined;
  sending();
  let result: DeliveryResult;
  try {
    // SAFETY: mount refused a Channel with neither.
    result = await channel.deliver!(surface, { markdown: text }, options);
  } catch (error) {
    // One provider call that threw: nothing reached the reader.
    return {
      status: "failed",
      retryable: true,
      error: { code: "CHANNEL_DELIVER_THREW", message: String(error) }
    };
  }
  if (
    !collected.interrupted ||
    text === INTERRUPTED_NOTICE ||
    result.status !== "delivered"
  ) {
    return result;
  }
  return {
    status: "uncertain",
    ...(result.reference !== undefined && { reference: result.reference }),
    error: {
      code: "CHANNEL_STREAM_INTERRUPTED",
      message:
        "An incomplete answer was delivered because the response ended early"
    }
  };
}

/**
 * A response's chunks from its start, live to its end, as a stream. An
 * interrupted response errors the stream only after every chunk it produced
 * was read.
 */
function readResponse(
  host: ChannelsHost,
  conversationId: string,
  responseId: string
): ReadableStream<ResponseChunk> {
  const controller = new AbortController();
  const queue: ResponseChunk[] = [];
  let ending: { error?: unknown } | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  void host
    .readResponse(conversationId, responseId, {
      from: 0,
      signal: controller.signal,
      onChunks: (_from, chunks) => {
        queue.push(...chunks);
        notify();
      },
      onCaughtUp: () => {}
    })
    .then(
      (end) => {
        ending =
          end === "ended"
            ? {}
            : end === "not-found"
              ? { error: new SupersededResponse(responseId) }
              : { error: new Error(`Response ${responseId} ${end}`) };
        notify();
      },
      (error: unknown) => {
        ending = { error };
        notify();
      }
    );
  return new ReadableStream<ResponseChunk>({
    async pull(stream) {
      while (queue.length === 0 && !ending) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const next = queue.shift();
      if (next !== undefined) {
        stream.enqueue(next);
        return;
      }
      if (ending?.error === undefined) stream.close();
      else stream.error(ending.error);
    },
    cancel() {
      controller.abort();
    }
  });
}

/**
 * A short, stable key for a surface, for its delivery's id: its `key` when
 * its Channel gives one (an email thread's root), else its address.
 */
async function surfaceKeyOf(surface: ChannelMessageSurface): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify(
        surface.key !== undefined ? { key: surface.key } : surface.address
      )
    )
  );
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
