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
 * Advance only when a failed destination has not started reading the answer.
 *
 * Replaying an arbitrarily large consumed prefix requires an arbitrarily large
 * buffer. Instead, each attempt gets a cancellation-shielded view of the same
 * source. Once an attempt asks for its first chunk, its result is terminal and
 * the source is never handed to another destination.
 */
async function streamWithFallbackBeforeRead(
  resolve: OutboundResolver,
  destinations: readonly ChannelMessageSurface[],
  chunks: ReadableStream<ChannelChunk>,
  options: ChannelStreamOptions
): Promise<DeliveryResult> {
  const reader = chunks.getReader();
  let drained = false;

  function attempt(): {
    chunks: ReadableStream<ChannelChunk>;
    startedReading: () => boolean;
  } {
    let startedReading = false;
    return {
      chunks: new ReadableStream<ChannelChunk>(
        {
          async pull(controller) {
            startedReading = true;
            const result = await reader.read();
            if (result.done) {
              drained = true;
              controller.close();
              return;
            }
            controller.enqueue(result.value);
          },
          // A destination may cancel after an opening failure. Shield the
          // untouched source so the next destination can still try it.
          cancel() {}
        },
        // Do not prefetch: creating an attempt must not consume the source.
        { highWaterMark: 0 }
      ),
      startedReading: () => startedReading
    };
  }

  try {
    for (let index = 0; index < destinations.length - 1; index += 1) {
      const destination = destinations[index]!;
      if (!(await resolve.isAvailable(destination))) continue;

      const current = attempt();
      const result = await resolve.stream(destination, current.chunks, options);
      if (result.status !== "failed" || current.startedReading()) return result;
    }
    const final = attempt();
    // `return await` so the shared reader is released only after the final
    // destination has finished consuming it.
    return await resolve.stream(destinations.at(-1)!, final.chunks, options);
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
      return streamWithFallbackBeforeRead(
        resolve,
        destinations,
        chunks,
        options
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
