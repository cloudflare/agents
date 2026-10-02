import type {
  Awaitable,
  Channel,
  ChannelChunkSource,
  ChannelDeliveryOptions,
  ChannelMessage,
  ChannelRoute,
  ChannelRouteContext,
  ChannelStreamOptions,
  DeliveryResult
} from "./channel";
import type {
  ChannelIdentity,
  ChannelIdentityInput,
  UserIdentity
} from "./identity";
import { unsupported } from "./internal";
import { collectText, messageChunks } from "./stream";
import type {
  ChannelEmailInput,
  ChannelIngressEnvelope,
  ChannelIngressEvent,
  ChannelIngressEventInput
} from "./ingress";
import { identityKey } from "./identity";
import type { GatewayOrigin, MessagePart, Participant } from "./protocol";
import {
  isChannelMessageSurface,
  type ChannelMessageSurface,
  type ChannelMessageSurfaceInput
} from "./surface";
import type { GatewayEvent } from "./conversations";
import { WEB_IDENTITY_HEADER, type WebIdentity } from "./web/protocol";

export type ChannelRouteEvent = {
  channelKey: string;
  event: ChannelIngressEvent;
  route: string | null;
  /** Stable identity derived only from the configured Channel and eventId. */
  dispatchId: string;
};

/** The conversation's agent, as the gateway reaches it. */
export type GatewayAgent = {
  /** Hand the agent an inbound event; Channels' `receive` serves it. */
  receive(event: GatewayEvent, origin: GatewayOrigin): Promise<unknown>;
  fetch(request: Request): Promise<Response>;
};

/**
 * Who a WebSocket upgrade is, which agent it reaches (`route`), and which
 * conversation there it follows. Without `conversationId`, the agent's
 * default for the route.
 */
export type GatewayWebIdentity = {
  route: string;
  conversationId?: string;
  participant: Participant;
};

export type ChannelGatewayOptions = {
  channels: Record<string, Channel>;
  /** The agent that holds a route's conversation. */
  agent(route: string): GatewayAgent;
  /**
   * Resolve a WebSocket upgrade from trusted request data, such as a
   * session cookie. Return null to refuse it, or undefined when the
   * request is not for Channels. Default: `/channels/<route>` or
   * `/channels/<route>/<conversation>` as an anonymous participant.
   */
  web?(request: Request): Awaitable<GatewayWebIdentity | null | undefined>;
  /** Used when a Channel does not provide a route. Default: event thread id. */
  defaultRoute?: ChannelRoute;
  /** Resolve an existing, explicitly linked application user. */
  findUser?(identity: ChannelIdentity): Promise<UserIdentity | null>;
  /** Observes every valid route outcome before it is sent to the agent. */
  onRoute?(event: ChannelRouteEvent): void | Promise<void>;
};

type OutboundOperation = (
  channel: Channel,
  surface: ChannelMessageSurface
) => Promise<DeliveryResult>;

/**
 * The Worker's entry point for Channels. Authenticates and normalizes
 * webhooks, resolves WebSocket upgrades, routes each to the agent that
 * holds its conversation, and sends to surfaces.
 */
export class ChannelGateway {
  readonly #channels: Record<string, Channel>;
  readonly #agent: ChannelGatewayOptions["agent"];
  readonly #web: NonNullable<ChannelGatewayOptions["web"]>;
  readonly #defaultRoute: ChannelRoute | undefined;
  readonly #findUser: ChannelGatewayOptions["findUser"];
  readonly #onRoute: ChannelGatewayOptions["onRoute"];

  constructor(options: ChannelGatewayOptions) {
    this.#channels = { ...options.channels };
    this.#agent = options.agent;
    this.#web = options.web ?? defaultWeb;
    this.#defaultRoute = options.defaultRoute;
    this.#findUser = options.findUser;
    this.#onRoute = options.onRoute;
  }

  /** Serve a request if it is for Channels, or return undefined. */
  async fetch(request: Request): Promise<Response | undefined> {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const web = await this.#upgrade(request);
      if (web) return web;
    }
    return this.#webhook(request);
  }

  /**
   * Forward a WebSocket upgrade to its conversation's agent with the
   * resolved identity. Any identity header the client sent is replaced.
   */
  async #upgrade(request: Request): Promise<Response | undefined> {
    const resolved = await this.#web(request);
    if (resolved === undefined) return undefined;
    if (resolved === null) {
      return new Response("Unauthorized", { status: 401 });
    }
    const identity: WebIdentity = {
      route: resolved.route,
      ...(resolved.conversationId !== undefined && {
        conversationId: resolved.conversationId
      }),
      participant: resolved.participant
    };
    const headers = new Headers(request.headers);
    headers.set(WEB_IDENTITY_HEADER, JSON.stringify(identity));
    return this.#agent(resolved.route).fetch(new Request(request, { headers }));
  }

  async #webhook(request: Request): Promise<Response | undefined> {
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

  /** Deliver through the configured Channel named by the surface. */
  deliver(
    surface: ChannelMessageSurface,
    message: ChannelMessage,
    options?: ChannelDeliveryOptions
  ): Promise<DeliveryResult> {
    return this.#outbound(surface, (channel, destination) => {
      if (channel.deliver) {
        return channel.deliver(destination, message, options);
      }
      // A Channel that streams renders a message the same way as an answer.
      if (channel.stream) {
        return channel.stream(destination, messageChunks(message.markdown), {
          ...(message.title !== undefined && { title: message.title }),
          ...options
        });
      }
      return Promise.resolve(
        unsupported(
          "CHANNEL_DELIVERY_UNSUPPORTED",
          `Channel "${destination.channelKey}" does not support delivery`
        )
      );
    });
  }

  /**
   * Deliver a progressively generated answer to the Channel
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
    if (!isChannelMessageSurface(surface)) {
      await chunks.cancel().catch(() => {});
      return invalidSurface();
    }

    let channel: Channel;
    try {
      channel = this.#configuredChannel(surface.channelKey);
    } catch (error) {
      await chunks.cancel().catch(() => {});
      throw error;
    }
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

  async #outbound(
    surface: ChannelMessageSurface,
    operation: OutboundOperation
  ): Promise<DeliveryResult> {
    if (!isChannelMessageSurface(surface)) return invalidSurface();
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
    if (!event.replySurface) {
      throw new Error(
        `Channel "${channelKey}" produced an event without a reply surface`
      );
    }
    await this.#agent(route).receive(toInboundEvent(event, dispatchId), {
      route,
      participant: participantOf(channelKey, event),
      surface: event.replySurface
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
const defaultWeb = (request: Request): GatewayWebIdentity | undefined => {
  const match = /^\/channels\/([^/]+)(?:\/([^/]+))?$/.exec(
    new URL(request.url).pathname
  );
  if (!match) return undefined;
  return {
    route: decodeURIComponent(match[1]),
    ...(match[2] !== undefined && {
      conversationId: decodeURIComponent(match[2])
    }),
    participant: { id: "anonymous" }
  };
};

/** The provider's event as an inbound event, keyed by its dispatch id. */
function toInboundEvent(
  event: ChannelIngressEvent,
  dispatchId: string
): GatewayEvent {
  if (event.type === "approval-response") {
    return {
      type: "approval-response",
      eventId: dispatchId,
      approvalId: event.approvalId,
      approved: event.decision === "approve"
    };
  }
  const { message } = event;
  const parts: MessagePart[] = [
    { type: "text", text: message.markdown ?? message.text }
  ];
  for (const attachment of message.attachments ?? []) {
    if (attachment.url && attachment.mediaType) {
      parts.push({
        type: "file",
        url: attachment.url,
        mediaType: attachment.mediaType,
        ...(attachment.name !== undefined && { filename: attachment.name })
      });
    }
  }
  return {
    type: "message",
    eventId: dispatchId,
    message: { id: dispatchId, role: "user", parts }
  };
}

function participantOf(
  channelKey: string,
  event: ChannelIngressEvent
): Participant {
  const actor = event.actor;
  const name = actor?.fullName ?? actor?.username;
  return {
    id: actor?.identity
      ? identityKey(actor.identity)
      : `${channelKey}:${actor?.id ?? "unknown"}`,
    ...(name !== undefined && { name })
  };
}

function invalidSurface(): DeliveryResult {
  return unsupported(
    "CHANNEL_SURFACE_INVALID",
    "Cannot resolve an invalid Channel message surface"
  );
}

async function collectAndDeliver(
  channel: Channel,
  surface: ChannelMessageSurface,
  stream: ChannelChunkSource,
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
