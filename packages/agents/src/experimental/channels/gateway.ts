import type {
  Channel,
  ChannelChunkSource,
  ChannelDeliveryOptions,
  ChannelMessage,
  ChannelStreamOptions,
  ChannelUpgrade,
  ChannelUpgradeMatch,
  DeliveryResult
} from "./channel";
import type { ChannelIdentity, ChannelIdentityInput } from "./identity";
import { participantRoute, toParticipant, unsupported } from "./internal";
import { collectText, messageChunks } from "./stream";
import type {
  ChannelEmailInput,
  ChannelIngressEnvelope,
  ChannelIngressEvent,
  ChannelIngressEventInput
} from "./ingress";
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
  /** Who the Channel resolved the sender as; null when it refused them. */
  participant: Participant | null;
  /** The agent object the event reaches; null when it is ignored or refused. */
  route: string | null;
  /** Stable identity derived only from the configured Channel and eventId. */
  dispatchId: string;
};

/** The agent object a route names, as the gateway reaches it. */
export type GatewayAgent = {
  /** Hand the agent an inbound event; Channels' `receive` serves it. */
  receive(event: GatewayEvent, origin: GatewayOrigin): Promise<unknown>;
  fetch(request: Request): Promise<Response>;
};

export type ChannelGatewayOptions = {
  /**
   * The Channels this Worker serves. Each one that takes ingress says who
   * its senders are (`participant`) and which agent object they reach
   * (`route`).
   */
  channels: Record<string, Channel>;
  /** The agent object a route names. */
  agent(route: string): GatewayAgent;
  /** Observes every valid route outcome before it is sent to the agent. */
  onRoute?(event: ChannelRouteEvent): void | Promise<void>;
};

type OutboundOperation = (
  channel: Channel,
  surface: ChannelMessageSurface
) => Promise<DeliveryResult>;

/**
 * The Worker's entry point for Channels. Authenticates and normalizes
 * webhooks, resolves WebSocket upgrades, routes each to the agent object
 * its route names, and sends to surfaces.
 *
 * The gateway is the trust boundary. It alone decides who a sender is and
 * tells the agent, so an agent serving Channels must be reachable only
 * through it: an app that forwards an upgrade to the agent some other way
 * (another fetch handler, `routeAgentRequest`, RPC) lets the caller pick
 * its own participant and conversation.
 *
 * The agent object is the authorization boundary. Whoever a Channel routes
 * to an object may list, join, create, fork and reset every conversation in
 * it. To keep people apart, route them to different objects; by default
 * each participant gets an object of their own.
 */
export class ChannelGateway {
  readonly #channels: Record<string, Channel>;
  readonly #agent: ChannelGatewayOptions["agent"];
  readonly #onRoute: ChannelGatewayOptions["onRoute"];

  constructor(options: ChannelGatewayOptions) {
    this.#channels = { ...options.channels };
    for (const [channelKey, channel] of Object.entries(this.#channels)) {
      if ((channel.ingress || channel.emailIngress) && !channel.participant) {
        throw new Error(
          `Channel "${channelKey}" takes ingress but has no participant; say who its senders are`
        );
      }
    }
    this.#agent = options.agent;
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
   * Forward a WebSocket upgrade to its agent with the resolved identity.
   * Any identity header the client sent is replaced. An upgrade no Channel
   * takes is left to the Worker, header and all, so the Worker must not
   * forward it to a Channels agent.
   */
  async #upgrade(request: Request): Promise<Response | undefined> {
    for (const [channelKey, channel] of Object.entries(this.#channels)) {
      const upgrade = channel.upgrade;
      const match = upgrade?.match(request);
      if (!upgrade || !match) continue;
      return this.#forwardUpgrade(channelKey, upgrade, match, request);
    }
    return undefined;
  }

  async #forwardUpgrade(
    channelKey: string,
    upgrade: ChannelUpgrade,
    match: ChannelUpgradeMatch,
    request: Request
  ): Promise<Response> {
    const source = `Channel "${channelKey}"`;
    const participant = toParticipant(
      await upgrade.participant(request),
      source
    );
    if (!participant) return new Response("Unauthorized", { status: 401 });
    const route = checkRoute(await upgrade.route(request, participant), source);
    if (route === null) return new Response("Forbidden", { status: 403 });
    const identity: WebIdentity = {
      route,
      ...(match.conversationId !== undefined && {
        conversationId: match.conversationId
      }),
      participant
    };
    const headers = new Headers(request.headers);
    headers.set(WEB_IDENTITY_HEADER, JSON.stringify(identity));
    return this.#agent(route).fetch(new Request(request, { headers }));
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
    const source = `Channel "${channelKey}"`;
    // The constructor checked that every Channel with ingress has one.
    const participant = toParticipant(
      await channel.participant!(event, envelope.raw),
      source
    );
    const route = participant
      ? checkRoute(
          channel.route
            ? await channel.route(event, envelope.raw, participant)
            : participantRoute(participant),
          source
        )
      : null;
    const dispatchId = await createDispatchId(channelKey, event.eventId);
    await this.#onRoute?.({
      channelKey,
      event,
      participant,
      route,
      dispatchId
    });
    if (!participant || route === null) return;
    if (!event.replySurface) {
      throw new Error(
        `Channel "${channelKey}" produced an event without a reply surface`
      );
    }
    await this.#agent(route).receive(toInboundEvent(event, dispatchId), {
      route,
      participant,
      surface: event.replySurface
    });
  }
}

/** Check what an application's `route` callback returned. */
function checkRoute(route: unknown, source: string): string | null {
  if (route === undefined) {
    throw new Error(
      `${source} route returned undefined; return null to ignore an event`
    );
  }
  if (route !== null && typeof route !== "string") {
    throw new Error(`${source} route must return a string or null`);
  }
  return route;
}

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

function invalidSurface(): DeliveryResult {
  return unsupported(
    "CHANNEL_SURFACE_INVALID",
    "Cannot resolve an invalid Channel message surface"
  );
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
