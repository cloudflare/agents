import type { ChannelIngressEvent } from "./ingress";
import { participantRoute } from "./internal";
import type { Participant } from "./protocol";

/**
 * Common deterministic routing policies for normalized Channel events.
 *
 * Each one maps an event to a namespaced agent object. That object is the
 * authorization boundary: anyone routed to it may use every conversation in
 * it. Deciding whether an event is relevant at all is application policy:
 * write that in your own `route` function and return `null` to ignore it.
 */
export const routes = {
  /**
   * Give each participant an agent object of their own. The default for every
   * Channel, so that a group chat never shares an object by accident.
   */
  perParticipant(
    _event: ChannelIngressEvent,
    _raw: unknown,
    participant: Participant
  ): string {
    return participantRoute(participant);
  },

  /**
   * Give every event its own application route. Useful to kick off a
   * new conversation for each ingress, and where you don't want subsequent
   * messages routed back to that same conversation.
   **/
  perEvent(event: ChannelIngressEvent): string {
    return `event:${event.eventId}`;
  },

  /**
   * Send every event in the same thread to the same object, whoever sent
   * it. Everyone in the thread can then use that object's conversations.
   */
  perThread(event: ChannelIngressEvent): string {
    return `thread:${event.thread.id}`;
  }
};
