import type { Channel } from "./channel";

/** A non-empty sequence of channels ordered from preferred to final fallback. */
export type FallbackChannelOptions = readonly [Channel, ...Channel[]];

async function isAvailable(channel: Channel): Promise<boolean> {
  return channel.isAvailable?.() ?? true;
}

/**
 * Compose channels in preference order, selecting the first available route.
 *
 * A definitive `failed` result advances to the next channel because the
 * transport confirmed that no delivery occurred. A `delivered` or `uncertain`
 * result is final so fallback cannot duplicate a delivery. The final channel is
 * always attempted so the composition produces a delivery result even when
 * every route reports unavailable.
 */
export function fallback(channels: FallbackChannelOptions): Channel {
  return {
    async isAvailable() {
      for (const channel of channels) {
        if (await isAvailable(channel)) return true;
      }
      return false;
    },

    async deliver(message, context) {
      for (let index = 0; index < channels.length - 1; index += 1) {
        const channel = channels[index];
        if (channel && (await isAvailable(channel))) {
          const result = await channel.deliver(message, context);
          if (result.status !== "failed") return result;
        }
      }

      const finalChannel = channels[channels.length - 1];
      return finalChannel.deliver(message, context);
    }
  };
}
