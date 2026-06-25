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

/** Surface family for a channel. Drives the default ingress/delivery wiring. */
export type ChannelKind = "messenger" | "web" | "voice" | "custom";

/** A channel's capabilities are the same shape as a messenger's. */
export type ChannelCapabilities = MessengerCapabilities;

/** A channel's delivery policy is the same shape as a messenger's. */
export type ChannelDeliveryPolicy = MessengerDeliveryPolicy;

/** Where a channel posts replies/notices. */
export type ChannelDeliverySurface = MessengerDeliverySurface;

/**
 * How events arrive for a channel. A discriminated union so `web`/`voice` do
 * not have to invent webhook fields they don't use. The `webhook` transport is
 * exactly today's messenger ingress (a full {@link MessengerDefinition}).
 */
export type ChannelIngress =
  | ({ transport: "webhook" } & MessengerDefinition)
  | { transport: "websocket" }
  | { transport: "voice" };

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
 * The public channel contract — the generalization of a messenger: an ingress,
 * a delivery surface, capabilities, conversation routing, a delivery policy, and
 * (new) per-channel policy.
 */
export interface ChannelDefinition {
  kind: ChannelKind;
  capabilities?: ChannelCapabilities;
  conversation?: MessengerConversationMode | MessengerConversationResolver;
  delivery?: ChannelDeliveryPolicy;
  /** Per-channel instructions, prepended to the system prompt for this channel. */
  instructions?: string | ((ctx: ChannelContext) => string | Promise<string>);
  /** Narrow the assembled tool set for this channel. */
  tools?: (all: ToolSet) => ToolSet;
  /** Per-channel cap on model steps for a turn. */
  maxTurns?: number;
  ingress: ChannelIngress;
}

export type ThinkChannels = Record<string, ChannelDefinition>;

export type NormalizedChannelDefinition = ChannelDefinition & { id: string };

/** Wrap a {@link MessengerDefinition} as a `kind: "messenger"` channel. */
export function messengerChannel(
  definition: MessengerDefinition
): ChannelDefinition {
  return {
    kind: "messenger",
    capabilities: definition.capabilities,
    conversation: definition.conversation,
    delivery: definition.delivery,
    ingress: { transport: "webhook", ...definition }
  };
}

function messengerFromChannel(
  definition: ChannelDefinition
): MessengerDefinition | undefined {
  const ingress = definition.ingress;
  if (ingress.transport !== "webhook") {
    return undefined;
  }
  const { transport: _transport, ...messenger } = ingress;
  return messenger;
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
      if (definition.kind !== "web") {
        throw new Error(
          `Channel "web" is reserved for the built-in WebSocket chat surface; configureChannels() may override its policy with a { kind: "web" } entry but cannot replace it with kind "${definition.kind}"`
        );
      }
      // Merge over the implicit web defaults so a policy-only override (e.g.
      // just `instructions`) keeps the built-in capabilities/ingress instead of
      // silently dropping them.
      channels.set("web", {
        ...IMPLICIT_WEB_CHANNEL,
        ...definition,
        id: "web"
      });
      continue;
    }
    channels.set(id, { ...definition, id });
  }

  const messengerDefs: ThinkMessengers = {};

  for (const [id, definition] of Object.entries(configured)) {
    const messenger = messengerFromChannel(definition);
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
