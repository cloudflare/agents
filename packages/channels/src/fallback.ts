import type {
  Channel,
  ChannelApprovalRequestOptions,
  ChannelDeliveryContext,
  ChannelMessage,
  DeliveryResult,
  OutboundResolver
} from "./channel";
import { compositeDestinations, unsupported } from "./internal";
import type { ChannelMessageSurface } from "./surface";

export type FallbackSurface = ChannelMessageSurface<
  "fallback",
  { surfaces: readonly ChannelMessageSurface[] }
>;

/** A non-empty sequence of destinations ordered from preferred to final. */
export type FallbackSurfaceOptions = readonly [
  ChannelMessageSurface,
  ...ChannelMessageSurface[]
];

type FallbackOperation = (
  surface: ChannelMessageSurface
) => Promise<DeliveryResult>;

/**
 * Build an inert fallback destination for a `ChannelHost` to resolve.
 *
 * The Host skips unavailable destinations, advances after confirmed failures,
 * and stops after a delivered or uncertain result to avoid duplicates.
 */
export function fallback(surfaces: FallbackSurfaceOptions): FallbackSurface {
  return {
    channelKey: "fallback",
    version: 1,
    address: { surfaces },
    label: surfaces.map((surface) => surface.label).join(", then ")
  };
}

/** Build the ordinary Channel installed under the reserved fallback key. */
export function fallbackChannel(resolve: OutboundResolver): Channel {
  async function run(
    surface: ChannelMessageSurface,
    operation: FallbackOperation
  ): Promise<DeliveryResult> {
    const destinations = compositeDestinations(surface);
    if (!destinations) {
      return unsupported(
        "FALLBACK_SURFACE_INVALID",
        "Fallback surface must contain at least one valid destination"
      );
    }

    for (let index = 0; index < destinations.length - 1; index += 1) {
      const destination = destinations[index]!;
      if (await resolve.isAvailable(destination)) {
        const result = await operation(destination);
        if (result.status !== "failed") return result;
      }
    }
    // try the last one if we haven't returned yet
    return operation(destinations.at(-1)!);
  }

  return {
    deliver(
      surface: ChannelMessageSurface,
      message: ChannelMessage,
      context?: ChannelDeliveryContext
    ) {
      return run(surface, (destination) =>
        resolve.deliver(destination, message, context)
      );
    },

    requestApproval(
      surface: ChannelMessageSurface,
      options: ChannelApprovalRequestOptions
    ) {
      return run(surface, (destination) =>
        resolve.requestApproval(destination, options)
      );
    },

    async isAvailable(surface) {
      const destinations = compositeDestinations(surface);
      if (!destinations) return true;
      for (const destination of destinations) {
        if (await resolve.isAvailable(destination)) return true;
      }
      return false;
    }
  };
}
