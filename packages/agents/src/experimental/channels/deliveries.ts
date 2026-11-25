import { registerDeliverySink, sendDelivery } from "../../internal/delivery";
import { NonRetryableError } from "../../tasks/errors";
import type { Tasks } from "../../tasks/tasks";
import type { Channel, DeliveryResult } from "./channel";
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

export type DeliverToSurfacesOptions = {
  /**
   * The Tasks capability the deliveries run on: the agent's own
   * (`this.tasks`), or one the host installs.
   */
  tasks: Tasks;
};

/** Checkpoint key: a provider call of this delivery may have started. */
const POSTING = "posting";

/**
 * Serve a gateway Channel (Slack, Telegram, email…) inside the agent: every
 * response of a conversation goes to each of that Channel's surfaces that
 * joined it, as a durable delivery run. Mount it under the key the
 * Channel has in the gateway, so the surfaces it serves are the ones the
 * gateway recorded:
 *
 * ```ts
 * readonly channels = Channels.forHarness(this.harness, {
 *   channels: {
 *     web: new WebChannel(),
 *     slack: deliverToSurfaces(slack({ botToken }), { tasks: this.tasks })
 *   }
 * });
 * ```
 *
 * A delivery is tried again with backoff while the Channel says the failure
 * is retryable. It is given up, and never posted twice, when the Channel
 * refuses it, when only part of it may have reached the reader
 * (`uncertain`), and when the object reset while it was being posted.
 *
 * @experimental The API surface may change before stabilizing.
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
        deliver: async (delivery, attempt) => {
          if (attempt.checkpoint.get(POSTING) === true) {
            // An attempt the object's reset cut short may have posted part
            // of the response: another would post it again.
            throw new NonRetryableError(
              "An earlier attempt may have posted part of this response"
            );
          }
          attempt.checkpoint.set(POSTING, true);
          const result = await post(channel, host, delivery);
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
      if (!mounted || !responseId) return;
      const { host, sink } = mounted;
      for (const surface of await host.surfaces(conversationId)) {
        const id = `${sink}:${responseId}:${await addressKey(surface)}`;
        // Not awaited: the first attempt streams the whole response.
        void sendDelivery<SurfaceDelivery>(options.tasks, sink, id, {
          conversationId,
          responseId,
          surface
        }).catch((error: unknown) => {
          console.error(`[channels] could not send ${id}`, error);
        });
      }
    }
  };
}

/** The response a turn update starts, if it starts one. */
function startedResponse(update: ConversationUpdate): string | undefined {
  return update.type === "turn" && update.turn.status === "running"
    ? update.turn.responseId
    : undefined;
}

/** Post one response to one surface: streamed, or collected and delivered. */
async function post(
  channel: Channel,
  host: ChannelsHost,
  { conversationId, responseId, surface }: SurfaceDelivery
): Promise<DeliveryResult> {
  const chunks = readResponse(host, conversationId, responseId);
  const options = { delivery: { deliveryId: responseId } };
  if (channel.stream) return channel.stream(surface, chunks, options);
  const collected = await collectText(chunks);
  // SAFETY: mount refused a Channel with neither.
  const result = await channel.deliver!(
    surface,
    { markdown: collected.text },
    options
  );
  if (!collected.interrupted || result.status !== "delivered") return result;
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

/** A response's chunks from its start, live to its end, as a stream. */
function readResponse(
  host: ChannelsHost,
  conversationId: string,
  responseId: string
): ReadableStream<ResponseChunk> {
  const controller = new AbortController();
  return new ReadableStream<ResponseChunk>({
    start(stream) {
      void host
        .readResponse(conversationId, responseId, {
          from: 0,
          signal: controller.signal,
          onChunks: (_from, chunks) => {
            for (const chunk of chunks) stream.enqueue(chunk);
          },
          onCaughtUp: () => {}
        })
        .then(
          (ending) => {
            if (ending === "ended") stream.close();
            else stream.error(new Error(`Response ${responseId} ${ending}`));
          },
          (error: unknown) => stream.error(error)
        );
    },
    cancel() {
      controller.abort();
    }
  });
}

/** A short, stable key for a surface's address, for its delivery's id. */
async function addressKey(surface: ChannelMessageSurface): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(surface.address))
  );
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
