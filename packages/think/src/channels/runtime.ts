/**
 * Channel resolution and out-of-turn notices for a Think agent. The channel
 * registry itself is built by {@link resolveChannels}; this module turns a
 * channel id into a turn's {@link ChannelContext} and delivers notices to a
 * channel's surface.
 */

import type { UIMessage } from "ai";
import type {
  DeliveryKind,
  MessengerContext,
  MessengerDeliverySurface
} from "../messengers";
import type { DeliverNoticeOptions } from "../turn-types";
import type { ChannelContext, NormalizedChannelDefinition } from "./index";

/**
 * Observability events about channels.
 *
 * @internal
 */
export type ChannelEvent =
  | {
      type: "channel:resolved";
      payload: { channel: string; kind: string; requestId?: string };
    }
  | {
      type: "channel:delivered";
      payload: { channel: string; kind: DeliveryKind; turnEnded: boolean };
    }
  | {
      type: "notice:delivered";
      payload: { channel: string; kind: DeliveryKind; informModel: boolean };
    }
  | {
      type: "notice:failed";
      payload: { channel: string; error: string };
    };

/**
 * Resolve a channel id to a turn-scoped {@link ChannelContext}. `registry`
 * is `undefined` on an agent that has no channel registry (a sub-agent),
 * where a missing channel is expected.
 *
 * @internal
 */
export function resolveChannelContext(
  channel: string | undefined,
  options: {
    registry: ReadonlyMap<string, NormalizedChannelDefinition> | undefined;
    requestId: string | undefined;
    messengerContext: () => MessengerContext | undefined;
    emit: (event: ChannelEvent) => void;
  }
): ChannelContext | undefined {
  if (!channel) {
    return undefined;
  }
  const definition = options.registry?.get(channel);
  if (!definition) {
    // A channel was requested but is not registered. Don't throw (a recovered
    // turn may name a channel later removed from `configureChannels()`), but
    // warn so a typo'd channel id is visible rather than silently policy-free.
    if (options.registry) {
      console.warn(
        `[Think] turn requested channel "${channel}" which is not registered ` +
          `(configureChannels()/getMessengers()); no per-channel policy applied`
      );
    }
    return undefined;
  }
  options.emit({
    type: "channel:resolved",
    payload: {
      channel,
      kind: definition.kind,
      requestId: options.requestId
    }
  });
  return {
    channelId: channel,
    kind: definition.kind,
    capabilities: definition.capabilities,
    messenger:
      definition.kind === "messenger" ? options.messengerContext() : undefined
  };
}

/**
 * A framework-authored assistant message that carries a notice.
 *
 * @internal
 */
export function noticeMessage(
  text: string,
  kind: DeliveryKind = "notice"
): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [{ type: "text", text }],
    metadata: { deliveryKind: kind }
  };
}

/**
 * What {@link deliverChannelNotice} needs from the agent.
 *
 * @internal
 */
export interface ChannelNoticeTarget {
  /** The channel to deliver to. */
  readonly channelId: string;
  readonly registry:
    | ReadonlyMap<string, NormalizedChannelDefinition>
    | undefined;
  /** The delivery surface for a non-web channel, if one can be found. */
  readonly surface: () => Promise<MessengerDeliverySurface | undefined>;
  /** Append to the transcript without starting a turn. */
  readonly addMessages: (messages: UIMessage[]) => Promise<unknown>;
  readonly emit: (event: ChannelEvent) => void;
}

/**
 * Deliver a no-turn notice to a channel. The `web` channel renders through
 * the transcript, so a web notice is always appended; other channels post to
 * their delivery surface and touch the transcript only with `informModel`.
 *
 * @throws When a non-web channel has no delivery surface.
 *
 * @internal
 */
export async function deliverChannelNotice(
  text: string | { markdown: string },
  options: DeliverNoticeOptions | undefined,
  target: ChannelNoticeTarget
): Promise<void> {
  const informModel = options?.informModel ?? false;
  const kind: DeliveryKind = options?.kind ?? "notice";
  const plain = typeof text === "string" ? text : text.markdown;
  const annotated = `[Delivered to the user out of band] ${plain}`;
  const channelId = target.channelId;

  try {
    if (channelId === "web") {
      await target.addMessages([
        noticeMessage(informModel ? annotated : plain, kind)
      ]);
    } else {
      const surface = await target.surface();
      if (!surface) {
        const kindOf = target.registry?.get(channelId)?.kind;
        let hint: string;
        if (kindOf === undefined) {
          hint = `; channel "${channelId}" is not registered`;
        } else if (kindOf === "messenger") {
          hint = options?.thread
            ? ` (thread "${options.thread}")`
            : "; pass { thread } for out-of-turn messenger notices";
        } else {
          hint = `; channel kind "${kindOf}" has no out-of-turn delivery surface yet`;
        }
        throw new Error(
          `deliverNotice: cannot resolve a delivery surface for channel "${channelId}"${hint}`
        );
      }
      await surface.post(
        typeof text === "string" ? text : { markdown: text.markdown }
      );
      if (informModel) {
        await target.addMessages([noticeMessage(annotated, kind)]);
      }
    }
    target.emit({
      type: "notice:delivered",
      payload: { channel: channelId, kind, informModel }
    });
  } catch (error) {
    target.emit({
      type: "notice:failed",
      payload: {
        channel: channelId,
        error: error instanceof Error ? error.message : String(error)
      }
    });
    throw error;
  }
}
