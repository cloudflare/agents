import type {
  Channel,
  ChannelApprovalRequestOptions,
  ChannelChunk,
  ChannelDeliveryOptions,
  ChannelMessage,
  ChannelStreamOptions,
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

/**
 * Advance past a failed destination, replaying what the failed one consumed.
 *
 * Buffering the answer keeps `failed` meaning that nothing reached the reader,
 * so streaming failover behaves exactly like one-shot failover. No Channel has
 * to obey an invisible rule about calling its provider before its first read.
 */
async function streamWithReplay(
  resolve: OutboundResolver,
  destinations: readonly ChannelMessageSurface[],
  chunks: ReadableStream<ChannelChunk>,
  options: ChannelStreamOptions
): Promise<DeliveryResult> {
  const reader = chunks.getReader();
  const buffered: ChannelChunk[] = [];
  let drained = false;

  function attempt(): ReadableStream<ChannelChunk> {
    let index = 0;
    return new ReadableStream<ChannelChunk>({
      async pull(controller) {
        if (index < buffered.length) {
          controller.enqueue(buffered[index]!);
          index += 1;
          return;
        }
        if (drained) {
          controller.close();
          return;
        }
        const result = await reader.read();
        if (result.done) {
          drained = true;
          controller.close();
          return;
        }
        buffered.push(result.value);
        index = buffered.length;
        controller.enqueue(result.value);
      }
      // A cancelling destination must not cancel the shared source, which the
      // next destination may still need.
    });
  }

  try {
    for (let index = 0; index < destinations.length - 1; index += 1) {
      const destination = destinations[index]!;
      if (!(await resolve.isAvailable(destination))) continue;

      const result = await resolve.stream(destination, attempt(), options);
      if (result.status !== "failed") return result;
    }
    // `return await` so the shared reader is released only after the final
    // destination has finished consuming it.
    return await resolve.stream(destinations.at(-1)!, attempt(), options);
  } finally {
    if (!drained) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
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
      options?: ChannelDeliveryOptions
    ) {
      return run(surface, (destination) =>
        resolve.deliver(destination, message, options)
      );
    },

    async stream(
      surface: ChannelMessageSurface,
      chunks: ReadableStream<ChannelChunk>,
      options: ChannelStreamOptions
    ) {
      const destinations = compositeDestinations(surface);
      if (!destinations) {
        await chunks.cancel().catch(() => {});
        return unsupported(
          "FALLBACK_SURFACE_INVALID",
          "Fallback surface must contain at least one valid destination"
        );
      }
      return streamWithReplay(resolve, destinations, chunks, options);
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
