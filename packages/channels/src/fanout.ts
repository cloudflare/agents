import type { Channel, DeliveryResult } from "./channel";

/** A non-empty set of Channels that must all receive each delivery. */
export type FanoutChannelOptions = readonly [Channel, ...Channel[]];

async function isAvailable(channel: Channel): Promise<boolean> {
  return channel.isAvailable?.() ?? true;
}

/**
 * Deliver each message to every configured Channel concurrently.
 *
 * A partial delivery is `uncertain` because retrying the composition could
 * duplicate delivery to destinations that already accepted the message. Only
 * unanimous confirmed failures are safely retryable as one fanout operation.
 */
export function fanout(channels: FanoutChannelOptions): Channel {
  return {
    async isAvailable() {
      const availability = await Promise.all(channels.map(isAvailable));
      return availability.every(Boolean);
    },

    async deliver(message, context) {
      const results = await Promise.all(
        channels.map((channel) => channel.deliver(message, context))
      );

      if (results.every((result) => result.status === "delivered")) {
        return { status: "delivered" };
      }

      if (results.every((result) => result.status === "failed")) {
        return {
          status: "failed",
          retryable: results.every(
            (result) => result.status === "failed" && result.retryable
          ),
          error: {
            code: "FANOUT_DELIVERY_FAILED",
            message: "Every fanout destination rejected the delivery"
          }
        };
      }

      return uncertain();
    }
  };
}

function uncertain(): DeliveryResult {
  return {
    status: "uncertain",
    error: {
      code: "FANOUT_DELIVERY_UNCERTAIN",
      message:
        "Fanout delivery was partial or had an uncertain destination outcome"
    }
  };
}
