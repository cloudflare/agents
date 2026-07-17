import type { ToolSet } from "ai";
import type {
  MessengerCapabilities,
  MessengerContext,
  MessengerConversationMode,
  MessengerConversationResolver,
  MessengerDefinition,
  MessengerDeliveryPolicy,
  MessengerDeliverySurface,
  ThinkMessengers
} from "../messengers";

/**
 * Surface family for a channel. Drives the default ingress/delivery wiring.
 *
 * @deprecated Transport ownership is moving out of Think and into user-owned
 * hosts that drive agents via {@link Think.ingest} (see the host pattern in
 * `docs/think/channels.md`). Channels are becoming pure behaviour policy, for
 * which a surface family is meaningless. Omit `kind` on new channels; it is
 * only consulted by the deprecated Think-owned `messenger`/`web` wiring.
 */
export type ChannelKind = "messenger" | "web" | "voice" | "custom";

/**
 * A channel's capabilities are the same shape as a messenger's.
 *
 * @deprecated Part of the Think-owned transport wiring; moving to hosts.
 */
export type ChannelCapabilities = MessengerCapabilities;

/**
 * A channel's delivery policy is the same shape as a messenger's.
 *
 * @deprecated Part of the Think-owned transport wiring; moving to hosts.
 */
export type ChannelDeliveryPolicy = MessengerDeliveryPolicy;

/**
 * Where a channel posts replies/notices.
 *
 * @deprecated Part of the Think-owned transport wiring; moving to hosts.
 */
export type ChannelDeliverySurface = MessengerDeliverySurface;

/**
 * How events arrive for a channel. A discriminated union so `web`/`voice` do
 * not have to invent webhook fields they don't use. The `webhook` transport is
 * exactly today's messenger ingress (a full {@link MessengerDefinition}).
 *
 * @deprecated Ingress belongs to the host, not the agent. Hosts own their
 * transport (webhooks, sockets, Chat SDK adapters) and call
 * {@link Think.ingest} over RPC; agent-side channels need no ingress.
 */
export type ChannelIngress =
  | ({ transport: "webhook" } & MessengerDefinition)
  | { transport: "websocket" }
  | { transport: "voice" }
  | { transport: string; [key: string]: unknown };

/**
 * Turn-scoped context the runtime sets when a turn resolves to a channel. For
 * `kind: "messenger"` it wraps the existing {@link MessengerContext}.
 */
export interface ChannelContext {
  channelId: string;
  kind: ChannelKind;
  capabilities?: ChannelCapabilities;
  messenger?: MessengerContext;
  thread?: string;
}

/**
 * The public channel contract — the generalization of a messenger: ingress,
 * capabilities, conversation routing, a delivery policy, and per-channel policy.
 */
export interface ChannelDefinition {
  /**
   * @deprecated Omit on new channels — a channel without `kind` is pure
   * behaviour policy (the intended end state). `kind` is only consulted by
   * the deprecated Think-owned `messenger`/`web` transport wiring.
   */
  kind?: ChannelKind;
  /** @deprecated Think-owned transport wiring; moving to user-owned hosts. */
  capabilities?: ChannelCapabilities;
  /** @deprecated Think-owned transport wiring; moving to user-owned hosts. */
  conversation?: MessengerConversationMode | MessengerConversationResolver;
  /** @deprecated Think-owned transport wiring; moving to user-owned hosts. */
  delivery?: ChannelDeliveryPolicy;
  /** Per-channel instructions, prepended to the system prompt for this channel. */
  instructions?: string | ((ctx: ChannelContext) => string | Promise<string>);
  /** Narrow the assembled tool set for this channel. */
  tools?: (all: ToolSet) => ToolSet;
  /** Per-channel cap on model steps for a turn. */
  maxTurns?: number;
  /**
   * Built-in transport configuration. Required for messenger channels.
   *
   * @deprecated Ingress belongs to the host; see {@link ChannelIngress}.
   */
  ingress?: ChannelIngress;
}

export type ThinkChannels = Record<string, ChannelDefinition>;

export type NormalizedChannelDefinition = ChannelDefinition & { id: string };

/**
 * Wrap a {@link MessengerDefinition} as a `kind: "messenger"` channel.
 *
 * @deprecated The Think-owned messenger runtime is being superseded by
 * user-owned hosts (e.g. a Chat SDK bot in the worker) that drive agents via
 * {@link Think.ingest} over RPC — see `examples/channel-host-telegram`.
 * Existing messenger apps keep working, but new integrations should use the
 * host pattern.
 */
export function messengerChannel(
  definition: MessengerDefinition
): ChannelDefinition {
  return {
    kind: "messenger",
    capabilities: definition.capabilities,
    conversation: definition.conversation,
    delivery: definition.delivery,
    ingress: {
      transport: "webhook",
      ...definition
    }
  };
}

function messengerFromChannel(
  definition: ChannelDefinition
): MessengerDefinition | undefined {
  const ingress = definition.ingress;
  if (!isWebhookIngress(ingress)) {
    return undefined;
  }
  const { transport: _transport, ...messenger } = ingress;
  return messenger;
}

function isWebhookIngress(
  ingress: ChannelIngress | undefined
): ingress is { transport: "webhook" } & MessengerDefinition {
  return ingress?.transport === "webhook" && "adapter" in ingress;
}

const IMPLICIT_WEB_CHANNEL: ChannelDefinition = {
  kind: "web",
  capabilities: { canStream: true, canEditMessages: true },
  ingress: { transport: "websocket" }
};

export interface ResolvedChannels {
  /** Every resolved channel keyed by id (registry for per-channel policy). */
  channels: Map<string, NormalizedChannelDefinition>;
  /** Messenger-kind channels mapped back to the runtime's input shape. */
  messengers: ThinkMessengers;
}

/**
 * Merge the implicit `web` channel, `configureChannels()` entries, and
 * `getMessengers()` entries into a single channel registry, and extract the
 * messenger definitions that feed the unchanged `ThinkMessengerRuntime`.
 *
 * Resolution order: (1) implicit `web`; (2) `configureChannels()`; (3) each
 * `getMessengers()` entry as a `kind: "messenger"` channel. A duplicate id
 * across (2) and (3) throws.
 */
export function resolveChannels(
  configured: ThinkChannels,
  messengers: ThinkMessengers
): ResolvedChannels {
  const channels = new Map<string, NormalizedChannelDefinition>();
  channels.set("web", { ...IMPLICIT_WEB_CHANNEL, id: "web" });

  for (const [id, definition] of Object.entries(configured)) {
    // `web` is reserved for the built-in WebSocket chat surface. Users may
    // override its *policy* (instructions / tool narrowing / maxTurns) with a
    // `{ kind: "web" }` entry, but replacing it with another kind would silently
    // break the native chat ingress/delivery path — reject that footgun loudly.
    if (id === "web") {
      // A policy-only entry (no kind) is always a legal web override; an
      // explicit non-web kind would silently break the native chat path.
      if (definition.kind !== undefined && definition.kind !== "web") {
        throw new Error(
          `Channel "web" is reserved for the built-in WebSocket chat surface; configureChannels() may override its policy (omit kind, or kind: "web") but cannot replace it with kind "${definition.kind}"`
        );
      }
      // Merge over the implicit web defaults so a policy-only override (e.g.
      // just `instructions`) keeps the built-in capabilities/ingress instead of
      // silently dropping them.
      channels.set("web", {
        ...IMPLICIT_WEB_CHANNEL,
        ...definition,
        ingress: definition.ingress ?? IMPLICIT_WEB_CHANNEL.ingress,
        id: "web"
      });
      continue;
    }
    channels.set(id, { ...definition, id });
  }

  const messengerDefs: ThinkMessengers = {};

  for (const [id, definition] of Object.entries(configured)) {
    const messenger = messengerFromChannel(definition);
    if (definition.kind === "messenger" && !messenger) {
      throw new Error(
        `Channel "${id}" with kind "messenger" requires webhook ingress; use messengerChannel(...) or provide messenger webhook ingress`
      );
    }
    if (definition.kind === "messenger" && messenger) {
      messengerDefs[id] = messenger;
    }
  }

  for (const [id, definition] of Object.entries(messengers)) {
    // Same reservation as the configureChannels() path: a messenger named
    // "web" would overwrite the built-in WebSocket chat surface with a
    // kind: "messenger" channel and break native chat ingress/delivery.
    if (id === "web") {
      throw new Error(
        `Channel "web" is reserved for the built-in WebSocket chat surface and cannot be declared as a messenger via getMessengers()`
      );
    }
    if (Object.prototype.hasOwnProperty.call(configured, id)) {
      throw new Error(
        `Channel id "${id}" is declared by both configureChannels() and getMessengers(); channel ids must be unique`
      );
    }
    channels.set(id, { ...messengerChannel(definition), id });
    messengerDefs[id] = definition;
  }

  return { channels, messengers: messengerDefs };
}
