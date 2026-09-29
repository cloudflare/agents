import type { ChannelRoute } from "./channel";
import { identityKey } from "./identity";
import type { ChannelIngressEvent } from "./ingress";

/**
 * Common deterministic routing policies for normalized Channel events.
 *
 * Each one maps an event to a namespaced application route. Deciding whether
 * an event is relevant at all is application policy: write that in your own
 * `route` function and return `null` to ignore the event.
 */
export const routes = {
  /**
   * Give every event its own application route. Useful to kick off a
   * new conversation for each ingress, and where you don't want subsequent
   * messages routed back to that same conversation.
   **/
  perEvent(event: ChannelIngressEvent): string {
    return `event:${event.eventId}`;
  },

  /** Send every event in the same thread to the same conversation */
  perThread(event: ChannelIngressEvent): string {
    return `thread:${event.thread.id}`;
  },

  /**
   * Prefer the sender's own channel identity, then delegate to another route
   * policy. Without a fallback, an event carrying no identity is ignored.
   *
   * This groups events that carry the *same* identity. It never infers that
   * two different identities belong to one person: that is an explicit
   * application decision, exposed to routing through `byUser`.
   */
  byIdentity<TRaw>(fallback?: ChannelRoute<TRaw>): ChannelRoute<TRaw> {
    return (event, raw, context) => {
      const identity = event.actor?.identity;
      if (identity) return `identity:${identityKey(identity)}`;
      return fallback ? fallback(event, raw, context) : null;
    };
  },

  /** Prefer an explicitly linked user, then delegate to another route policy. */
  byUser<TRaw>(fallback: ChannelRoute<TRaw>): ChannelRoute<TRaw> {
    return async (event, raw, context) => {
      const user = await context.findUser();
      return user ? `user:${user.id}` : fallback(event, raw, context);
    };
  }
};
