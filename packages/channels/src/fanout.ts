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

export type FanoutSurface = ChannelMessageSurface<
  "fanout",
  { surfaces: readonly ChannelMessageSurface[] }
>;

/** A non-empty set of destinations that must all receive each delivery. */
export type FanoutSurfaceOptions = readonly [
  ChannelMessageSurface,
  ...ChannelMessageSurface[]
];

type FanoutOperation = (
  surface: ChannelMessageSurface
) => Promise<DeliveryResult>;

/** Build an inert fanout destination for a `ChannelHost` to resolve. */
export function fanout(surfaces: FanoutSurfaceOptions): FanoutSurface {
  return {
    channelKey: "fanout",
    version: 1,
    address: { surfaces },
    label: surfaces.map((surface) => surface.label).join(" and ")
  };
}

/** Build the ordinary Channel installed under the reserved fanout key. */
export function fanoutChannel(resolve: OutboundResolver): Channel {
  async function run(
    surface: ChannelMessageSurface,
    operation: FanoutOperation
  ): Promise<DeliveryResult> {
    const destinations = compositeDestinations(surface);
    if (!destinations) {
      return unsupported(
        "FANOUT_SURFACE_INVALID",
        "Fanout surface must contain at least one valid destination"
      );
    }

    const results = await Promise.all(destinations.map(operation));
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
    return {
      status: "uncertain",
      error: {
        code: "FANOUT_DELIVERY_UNCERTAIN",
        message:
          "Fanout delivery was partial or had an uncertain destination outcome"
      }
    };
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
      const available = await Promise.all(
        destinations.map((destination) => resolve.isAvailable(destination))
      );
      return available.every(Boolean);
    }
  };
}
