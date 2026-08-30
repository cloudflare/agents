import type {
  Channel,
  ChannelApprovalRequestOptions,
  ChannelChunk,
  ChannelChunkSource,
  ChannelDeliveryOptions,
  ChannelMessage,
  ChannelRoute,
  ChannelRouteContext,
  ChannelStreamOptions,
  DeliveryResult
} from "../channel";
import { fallbackChannel } from "../fallback";
import { fanoutChannel } from "../fanout";
import type {
  ChannelIdentity,
  ChannelIdentityInput,
  UserIdentity
} from "../identity";
import {
  bindChannelIngress,
  type BindableChannelIngress,
  unsupported
} from "../internal";
import { collectText } from "../stream";
import type {
  ChannelApprovalResponse,
  ChannelEmailInput,
  ChannelInboundMessage,
  ChannelIngressEnvelope,
  ChannelIngressEvent,
  ChannelIngressEventInput
} from "../ingress";
import type {
  ChannelMessageSurface,
  ChannelMessageSurfaceInput
} from "../surface";

export type ChannelMessageEvent = {
  channelKey: string;
  route: string;
  /** Stable identity derived only from the configured Channel and eventId. */
  dispatchId: string;
  message: ChannelInboundMessage;
};

export type ChannelApprovalResponseEvent = {
  channelKey: string;
  route: string;
  /** Stable identity derived only from the configured Channel and eventId. */
  dispatchId: string;
  response: ChannelApprovalResponse;
};

export type ChannelRouteEvent = {
  channelKey: string;
  event: ChannelIngressEvent;
  route: string | null;
  /** Stable identity derived only from the configured Channel and eventId. */
  dispatchId: string;
};

export type ChannelHostOptions = {
  channels: Record<string, Channel>;
  /** Used when a Channel does not provide a route. Default: event thread id. */
  defaultRoute?: ChannelRoute;
  /** Resolve an existing, explicitly linked application user. */
  findUser?(identity: ChannelIdentity): Promise<UserIdentity | null>;
  /** Observes every valid route outcome before application dispatch. */
  onRoute?(event: ChannelRouteEvent): void | Promise<void>;
  onMessage?(event: ChannelMessageEvent): void | Promise<void>;
  onApprovalResponse?(
    event: ChannelApprovalResponseEvent
  ): void | Promise<void>;
};

type OutboundOperation = (
  channel: Channel,
  surface: ChannelMessageSurface
) => Promise<DeliveryResult>;

const POLICY_KEYS = new Set(["fallback", "fanout"]);

/**
 * Authenticates and normalizes ingress through configured Channel adapters,
 * resolves outbound surfaces, and awaits the application's durable handoff.
 */
export class ChannelHost {
  readonly #channels: Record<string, Channel>;
  readonly #defaultRoute: ChannelRoute | undefined;
  readonly #findUser: ChannelHostOptions["findUser"];
  readonly #onRoute: ChannelHostOptions["onRoute"];
  readonly #onMessage: ChannelHostOptions["onMessage"];
  readonly #onApprovalResponse: ChannelHostOptions["onApprovalResponse"];

  constructor(options: ChannelHostOptions) {
    for (const channelKey of Object.keys(options.channels)) {
      if (POLICY_KEYS.has(channelKey)) {
        throw new Error(
          `Channel key "${channelKey}" is reserved for a delivery policy`
        );
      }
    }
    const channels = { ...options.channels };
    this.#channels = channels;
    channels.fallback = fallbackChannel(this);
    channels.fanout = fanoutChannel(this);
    this.#defaultRoute = options.defaultRoute;
    this.#findUser = options.findUser;
    this.#onRoute = options.onRoute;
    this.#onMessage = options.onMessage;
    this.#onApprovalResponse = options.onApprovalResponse;

    for (const [channelKey, channel] of Object.entries(options.channels)) {
      const bind = (channel as Channel & Partial<BindableChannelIngress>)[
        bindChannelIngress
      ];
      bind?.call(channel, (envelope) =>
        this.#dispatch(channelKey, channel, envelope)
      );
    }
  }

  async handleRequest(request: Request): Promise<Response | undefined> {
    for (const [channelKey, channel] of Object.entries(this.#channels)) {
      const ingress = channel.ingress;
      if (!ingress) continue;

      try {
        const result = await ingress.receive(request);
        if (!result) continue;
        for (const envelope of result.events) {
          await this.#dispatch(channelKey, channel, envelope);
        }
        return result.response;
      } catch {
        return new Response("Failed to handle Channel event", { status: 500 });
      }
    }
    return undefined;
  }

  async handleEmail(email: ChannelEmailInput): Promise<boolean> {
    for (const [channelKey, channel] of Object.entries(this.#channels)) {
      const ingress = channel.emailIngress;
      if (!ingress) continue;

      const result = await ingress.receive(email);
      if (!result) continue;
      for (const envelope of result.events) {
        await this.#dispatch(channelKey, channel, envelope);
      }
      return true;
    }
    return false;
  }

  /** Deliver through the configured Channel or composite named by the surface. */
  deliver(
    surface: ChannelMessageSurface,
    message: ChannelMessage,
    options?: ChannelDeliveryOptions
  ): Promise<DeliveryResult> {
    return this.#outbound(surface, (channel, destination) => {
      if (!channel.deliver) {
        return Promise.resolve(
          unsupported(
            "CHANNEL_DELIVERY_UNSUPPORTED",
            `Channel "${destination.channelKey}" does not support delivery`
          )
        );
      }
      return channel.deliver(destination, message, options);
    });
  }

  /**
   * Deliver a progressively generated answer to the Channel or composite
   * named by the surface.
   *
   * A Channel that can stream consumes the stream itself. A Channel that
   * cannot never learns it was a stream, because the Host collects the answer
   * and calls `deliver` once.
   */
  async stream(
    surface: ChannelMessageSurface,
    chunks: ChannelChunkSource,
    options: ChannelStreamOptions = {}
  ): Promise<DeliveryResult> {
    const channel = this.#configuredChannel(surface.channelKey);
    if (!channel.stream && !channel.deliver) {
      await chunks.cancel().catch(() => {});
      return unsupported(
        "CHANNEL_DELIVERY_UNSUPPORTED",
        `Channel "${surface.channelKey}" does not support delivery`
      );
    }

    if (channel.stream) return channel.stream(surface, chunks, options);
    return collectAndDeliver(channel, surface, chunks, options);
  }

  /** Request approval through the Channel or composite named by the surface. */
  requestApproval(
    surface: ChannelMessageSurface,
    options: ChannelApprovalRequestOptions
  ): Promise<DeliveryResult> {
    return this.#outbound(surface, (channel, destination) => {
      if (!channel.requestApproval) {
        return Promise.resolve(
          unsupported(
            "CHANNEL_APPROVAL_UNSUPPORTED",
            `Channel "${destination.channelKey}" does not support approval requests`
          )
        );
      }
      return channel.requestApproval(destination, options);
    });
  }

  /** Return the identity's configured Channel destination, when supported. */
  contactSurface(identity: ChannelIdentity): ChannelMessageSurface | null {
    const channel = Object.prototype.hasOwnProperty.call(
      this.#channels,
      identity.channelKey
    )
      ? this.#channels[identity.channelKey]
      : undefined;
    const surface = channel?.contactSurface?.(identity);
    return surface ? stampSurface(identity.channelKey, surface) : null;
  }

  /** Resolve whether a surface can currently be selected without delivery. */
  async isAvailable(surface: ChannelMessageSurface): Promise<boolean> {
    const channel = this.#configuredChannel(surface.channelKey);
    return channel.isAvailable?.(surface) ?? true;
  }

  async #outbound(
    surface: ChannelMessageSurface,
    operation: OutboundOperation
  ): Promise<DeliveryResult> {
    const channel = this.#configuredChannel(surface.channelKey);
    return operation(channel, surface);
  }

  #configuredChannel(channelKey: string): Channel {
    const channel = Object.prototype.hasOwnProperty.call(
      this.#channels,
      channelKey
    )
      ? this.#channels[channelKey]
      : undefined;
    if (!channel) {
      throw new Error(
        `Channel message surface names unknown configured Channel key "${channelKey}"`
      );
    }
    return channel;
  }

  async #dispatch(
    channelKey: string,
    channel: Channel,
    envelope: ChannelIngressEnvelope
  ): Promise<void> {
    const rawEvent = envelope.event;
    const event = stampEvent(channelKey, rawEvent);
    const route = await this.#route(channelKey, channel, event, envelope.raw);
    const dispatchId = await createDispatchId(channelKey, event.eventId);
    await this.#onRoute?.({ channelKey, event, route, dispatchId });
    if (route === null) return;

    if (event.type === "message") {
      if (!this.#onMessage) {
        throw new Error(
          `Channel "${channelKey}" received a message without an onMessage callback`
        );
      }
      await this.#onMessage({ channelKey, route, dispatchId, message: event });
      return;
    }
    if (!this.#onApprovalResponse) {
      throw new Error(
        `Channel "${channelKey}" received an approval response without an onApprovalResponse callback`
      );
    }
    await this.#onApprovalResponse({
      channelKey,
      route,
      dispatchId,
      response: event
    });
  }

  async #route(
    channelKey: string,
    channel: Channel,
    event: ChannelIngressEvent,
    raw: unknown
  ): Promise<string | null> {
    const context = this.#routeContext(event);
    const route = channel.route
      ? await channel.route(event, raw, context)
      : this.#defaultRoute
        ? await this.#defaultRoute(event, raw, context)
        : event.thread.id;

    if (route === undefined) {
      throw new Error(
        `Channel route for "${channelKey}" returned undefined; return null to ignore an event`
      );
    }
    if (route !== null && typeof route !== "string") {
      throw new Error(
        `Channel route for "${channelKey}" must return a string or null`
      );
    }
    return route;
  }

  #routeContext(event: ChannelIngressEvent): ChannelRouteContext {
    let linkedUser: Promise<UserIdentity | null> | undefined;
    return {
      findUser: () => {
        if (!linkedUser) {
          const identity = event.actor?.identity;
          const findUser = this.#findUser;
          linkedUser =
            identity && findUser
              ? Promise.resolve().then(() => findUser(identity))
              : Promise.resolve(null);
        }
        return linkedUser;
      }
    };
  }
}

/**
 * Serve a Channel that cannot stream by collecting the answer first.
 *
 * A generation that failed part-way still delivers what it produced, because
 * losing the partial answer helps nobody, but the result is downgraded to
 * `uncertain` since the reader received an incomplete answer.
 */
async function collectAndDeliver(
  channel: Channel,
  surface: ChannelMessageSurface,
  stream: ReadableStream<ChannelChunk>,
  options: ChannelStreamOptions
): Promise<DeliveryResult> {
  const collected = await collectText(stream);
  if (collected.interrupted && collected.text.length === 0) {
    return {
      status: "failed",
      retryable: false,
      error: {
        code: "CHANNEL_STREAM_INTERRUPTED",
        message: "The stream ended before producing any content to deliver"
      }
    };
  }

  const result = await channel.deliver!(
    surface,
    {
      ...(options.title !== undefined && { title: options.title }),
      markdown: collected.text
    },
    options.delivery ? { delivery: options.delivery } : undefined
  );
  if (!collected.interrupted || result.status !== "delivered") return result;
  return {
    status: "uncertain",
    ...(result.reference !== undefined && { reference: result.reference }),
    error: {
      code: "CHANNEL_STREAM_INTERRUPTED",
      message:
        "An incomplete answer was delivered because the stream ended early"
    }
  };
}

function stampSurface<TAddress extends ChannelMessageSurfaceInput["address"]>(
  channelKey: string,
  surface: ChannelMessageSurfaceInput<TAddress>
): ChannelMessageSurface<string, TAddress> {
  return { ...surface, channelKey };
}

function stampIdentity(
  channelKey: string,
  identity: ChannelIdentityInput
): ChannelIdentity {
  return { ...identity, channelKey };
}

function stampEvent(
  channelKey: string,
  event: ChannelIngressEventInput
): ChannelIngressEvent {
  return {
    ...event,
    ...(event.replySurface && {
      replySurface: stampSurface(channelKey, event.replySurface)
    }),
    ...(event.actor && {
      actor: {
        ...event.actor,
        ...(event.actor.identity && {
          identity: stampIdentity(channelKey, event.actor.identity)
        })
      }
    })
  } as ChannelIngressEvent;
}

/** Hash an unambiguous tuple so dispatch identities remain safe to carry. */
async function createDispatchId(
  channelKey: string,
  eventId: string
): Promise<string> {
  const identity = new TextEncoder().encode(
    JSON.stringify([channelKey, eventId])
  );
  const digest = await crypto.subtle.digest("SHA-256", identity);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}
